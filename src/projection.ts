import type { LedgerState } from "./account-ledger";
import type { TxnEvent } from "./types";

/**
 * Projection from the Durable Object (CP) to D1 (AP).
 *
 * The ledger is authoritative; everything here is a copy kept for reads that
 * must not be serialized through a single object. That copy is allowed to lag,
 * and the dashboard is built to show that it does. What it is not allowed to do
 * is go backwards.
 *
 * The guard is a compare-and-set on projection_version. The DO returns a
 * monotonic version with every state, and the accounts upsert only applies when
 * that version is strictly greater than the stored one, so a delivery that
 * arrives late - a queue retry overtaken by the next event, two messages for one
 * account processed out of order - matches zero rows and disappears instead of
 * overwriting fresher state (spec 7.2).
 */

export interface ProjectionResult {
  applied: boolean;
  version: number;
  /** The version already in D1 when a write was rejected, for the log line. */
  storedVersion?: number;
}

/**
 * Write the account summary and its gaps. Returns whether the guard let the
 * write through; a rejected projection is normal, not an error.
 */
export async function projectAccount(
  env: Env,
  state: LedgerState,
): Promise<ProjectionResult> {
  // Run alone rather than inside the batch below, because the batch has to know
  // whether this succeeded before it decides to replace the gap rows. D1 has no
  // way to make later statements in a batch conditional on an earlier one.
  const upsert = await env.DB.prepare(
    `INSERT INTO accounts (account_id, bank, account_label, current_balance_paisa,
                           last_event_at, reconciliation_status, open_gap_count,
                           projection_version, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
     ON CONFLICT(account_id) DO UPDATE SET
       bank                  = excluded.bank,
       account_label         = excluded.account_label,
       current_balance_paisa = excluded.current_balance_paisa,
       last_event_at         = excluded.last_event_at,
       reconciliation_status = excluded.reconciliation_status,
       open_gap_count        = excluded.open_gap_count,
       projection_version    = excluded.projection_version
     WHERE excluded.projection_version > accounts.projection_version;`,
  )
    .bind(
      state.account_id,
      state.bank,
      state.account_label,
      state.current_balance_paisa,
      state.last_event_at,
      state.reconciliation_status,
      state.open_gap_count,
      state.version,
      state.created_at ?? new Date().toISOString(),
    )
    .run();

  if (upsert.meta.changes === 0) {
    const stored = await env.DB.prepare(
      `SELECT projection_version FROM accounts WHERE account_id = ?1;`,
    )
      .bind(state.account_id)
      .first<{ projection_version: number }>();
    return {
      applied: false,
      version: state.version,
      storedVersion: stored?.projection_version,
    };
  }

  // The DO returns the complete gap set for the account, so the projection is a
  // replace rather than a merge: a gap that filled is gone from the ledger and
  // must be gone from the read model, and there is no delete event to carry
  // that news on its own.
  const statements = [
    env.DB.prepare(`DELETE FROM gaps WHERE account_id = ?1;`).bind(state.account_id),
    ...state.gaps.map((gap) =>
      env.DB.prepare(
        `INSERT INTO gaps (gap_id, account_id, delta_paisa, status, detected_at,
                           confirmed_at, accepted_at, accept_reason,
                           after_event_id, before_event_id, fillable_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11);`,
      ).bind(
        gap.gap_id,
        state.account_id,
        gap.delta_paisa,
        gap.status,
        gap.detected_at,
        gap.confirmed_at,
        gap.accepted_at,
        gap.accept_reason,
        gap.after_event_id,
        gap.before_event_id,
        gap.fillable_at,
      ),
    ),
  ];
  // One batch, so the dashboard never reads a moment where the old gaps are
  // deleted and the new ones are not yet there.
  await env.DB.batch(statements);

  return { applied: true, version: state.version };
}

/**
 * Write the timeline row for one delivered event.
 *
 * Kept separate from the account projection because only the consumer knows
 * these columns - which R2 object holds the raw bytes, when it was received,
 * and whether this delivery was the first. The alarm re-projects an account
 * without any of that, and must not blank them.
 */
export async function projectTransaction(
  env: Env,
  event: TxnEvent,
  detail: {
    outcome: "applied" | "duplicate";
    delivery_count: number;
    raw_r2_key: string | null;
    received_at: string;
  },
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO transactions (event_id, account_id, occurred_at, direction,
                               amount_paisa, reported_balance_paisa, merchant,
                               reference, outcome, delivery_count, raw_r2_key,
                               received_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
     ON CONFLICT(event_id) DO UPDATE SET
       delivery_count = excluded.delivery_count
     WHERE excluded.delivery_count > transactions.delivery_count;`,
  )
    .bind(
      event.event_id,
      event.account_id,
      event.occurred_at,
      event.direction,
      event.amount_paisa,
      event.reported_balance_paisa,
      event.merchant,
      event.reference,
      detail.outcome,
      detail.delivery_count,
      detail.raw_r2_key,
      detail.received_at,
    )
    .run();
  // Only delivery_count is updated on conflict, and only upwards. The money
  // columns are settled history: the ledger already decided that the first
  // delivery wins, and the projection must not disagree with it. outcome stays
  // as the first delivery recorded it, so a row never changes from applied to
  // duplicate under a redelivery.
}
