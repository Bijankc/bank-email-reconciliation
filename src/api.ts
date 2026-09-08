import { keySegment } from "./audit";
import type { GapStatus, ReconciliationStatus } from "./account-ledger";
import { evaluateChain, pairKey } from "./chain";
import { projectAccount } from "./projection";
import type { Direction } from "./types";

/**
 * The dashboard read surface (spec 8).
 *
 * Everything here reads the D1 projection, which is eventually consistent by
 * construction, except the one endpoint that deliberately does not: passing
 * ?authoritative=true goes straight to the Durable Object. The two answers can
 * differ for as long as the queue takes, and being able to put them side by
 * side is the point - replication lag is a property of the design, not a defect
 * to hide behind a spinner.
 */

interface AccountRow {
  account_id: string;
  bank: string;
  account_label: string | null;
  current_balance_paisa: number | null;
  last_event_at: string | null;
  reconciliation_status: ReconciliationStatus;
  open_gap_count: number;
  projection_version: number;
  created_at: string;
}

interface TransactionRow {
  event_id: string;
  account_id: string;
  occurred_at: string;
  direction: Direction;
  amount_paisa: number;
  reported_balance_paisa: number;
  merchant: string | null;
  reference: string | null;
  outcome: "applied" | "duplicate";
  delivery_count: number;
  raw_r2_key: string | null;
  received_at: string;
}

interface GapRow {
  gap_id: string;
  account_id: string;
  delta_paisa: number;
  status: GapStatus;
  detected_at: string;
  confirmed_at: string | null;
  accepted_at: string | null;
  accept_reason: string | null;
  after_event_id: string | null;
  before_event_id: string | null;
  fillable_at: string | null;
}

/** GET /api/accounts - the account list the dashboard polls. */
export async function listAccounts(env: Env): Promise<unknown> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM accounts ORDER BY account_id ASC;`,
  ).all<AccountRow>();

  return {
    source: "projection",
    accounts: results,
  };
}

/**
 * GET /api/accounts/:id - the projected view: account summary, timeline with
 * every adjacency marked, and the gap list.
 *
 * The timeline is ordered and marked by the same chain code the ledger runs, so
 * a difference between this and the authoritative read is always lag and never
 * a disagreement about what the numbers mean.
 */
export async function getAccount(env: Env, accountId: string): Promise<unknown> {
  const account = await env.DB.prepare(
    `SELECT * FROM accounts WHERE account_id = ?1;`,
  )
    .bind(accountId)
    .first<AccountRow>();

  if (account === null) return null;

  const [transactions, gaps] = await Promise.all([
    env.DB.prepare(`SELECT * FROM transactions WHERE account_id = ?1;`)
      .bind(accountId)
      .all<TransactionRow>(),
    env.DB.prepare(
      `SELECT * FROM gaps WHERE account_id = ?1 ORDER BY detected_at ASC;`,
    )
      .bind(accountId)
      .all<GapRow>(),
  ]);

  const gapByPair = new Map<string, string>();
  for (const gap of gaps.results) {
    gapByPair.set(pairKey(gap.after_event_id, gap.before_event_id), gap.gap_id);
  }

  const evaluated = evaluateChain(transactions.results);
  const timeline = evaluated.map((entry, position) => ({
    ...entry,
    gap_id:
      position === 0
        ? null
        : gapByPair.get(
            pairKey(evaluated[position - 1].event_id, entry.event_id),
          ) ?? null,
  }));

  return {
    source: "projection",
    // Surfaced so the dashboard can show which version it is looking at next to
    // the authoritative one, which is what makes the lag legible.
    projection_version: account.projection_version,
    account,
    timeline,
    gaps: gaps.results,
  };
}

/**
 * GET /api/accounts/:id?authoritative=true - straight from the Durable Object,
 * bypassing the projection entirely. Slower, serialized through one object, and
 * always right.
 */
export async function getAuthoritativeAccount(
  env: Env,
  accountId: string,
): Promise<unknown> {
  const stub = env.ACCOUNT_LEDGER.get(env.ACCOUNT_LEDGER.idFromName(accountId));
  const snapshot = await stub.snapshot();

  // An object that has never seen an event still answers, because a Durable
  // Object is created on first reference. An empty ledger is "no such account".
  if (snapshot.event_count === 0) return null;

  return { source: "authoritative", ...snapshot };
}

/**
 * GET /api/accounts/:id/audit - what the audit bucket holds for this account.
 *
 * Keys and metadata only. The bodies are raw bank emails and this endpoint is
 * unauthenticated like the rest of the read surface, so it lists the evidence
 * without serving it.
 */
export async function listAudit(env: Env, accountId: string): Promise<unknown> {
  const prefix = `raw/${keySegment(accountId)}/`;
  const listing = await env.AUDIT.list({
    prefix,
    include: ["customMetadata"],
    limit: 200,
  });

  return {
    source: "audit",
    prefix,
    truncated: listing.truncated,
    objects: listing.objects.map((object) => ({
      key: object.key,
      size: object.size,
      uploaded: object.uploaded,
      event_id: object.customMetadata?.event_id ?? null,
      source_channel: object.customMetadata?.source_channel ?? null,
      occurred_at: object.customMetadata?.occurred_at ?? null,
      received_at: object.customMetadata?.received_at ?? null,
      truncated: object.customMetadata?.truncated === "true",
    })),
  };
}

/**
 * POST /api/accounts/:id/gaps/:gapId/accept - re-anchor (spec 6.5).
 *
 * The only write in the dashboard, and the only operation in the system that
 * asks a human to take responsibility for a number. It records the delta as an
 * accepted discontinuity with a reason attached, which is why the reason is
 * required rather than optional: a gap accepted without one is indistinguishable
 * later from a gap accepted by accident.
 */
export async function acceptGap(
  env: Env,
  accountId: string,
  gapId: string,
  reason: string | null,
): Promise<{ status: number; body: unknown }> {
  if (reason === null || reason.trim() === "") {
    return {
      status: 422,
      body: { error: "a reason is required to accept a gap" },
    };
  }

  const stub = env.ACCOUNT_LEDGER.get(env.ACCOUNT_LEDGER.idFromName(accountId));
  const result = await stub.acceptGap(gapId, reason.trim());

  if (!result.ok) {
    // 409, not 404: the gap may well exist, just not in a state that can be
    // accepted. The message says which.
    return { status: 409, body: { error: result.error } };
  }

  // Project immediately rather than waiting for the account's next transaction.
  // This change came in over HTTP, not on the queue, so nothing else will carry
  // it to the read model - the same reason the alarm projects itself.
  const projected = await projectAccount(env, result.state);

  return {
    status: 200,
    body: {
      accepted: true,
      gap: result.gap,
      account_id: accountId,
      version: result.state.version,
      reconciliation_status: result.state.reconciliation_status,
      open_gap_count: result.state.open_gap_count,
      projected: projected.applied,
    },
  };
}

/**
 * POST /api/accounts/:id/force-window - close the resolution window now.
 *
 * The fast-forward the simulator panel needs (spec 10). It lands here rather
 * than in the simulator phase because the re-anchor control cannot be
 * demonstrated at all without it: accepting requires a CONFIRMED_GAP, and
 * reaching one otherwise means waiting 48 hours.
 *
 * It is not a shortcut around the lifecycle. It runs the same promotion the
 * alarm runs, so what a demo shows is the real transition rather than a mock of
 * it, and it is bearer-authenticated because it changes recorded state.
 */
export async function forceWindow(
  env: Env,
  accountId: string,
): Promise<{ status: number; body: unknown }> {
  const stub = env.ACCOUNT_LEDGER.get(env.ACCOUNT_LEDGER.idFromName(accountId));
  const state = await stub.forceWindow();
  const projected = await projectAccount(env, state);

  return {
    status: 200,
    body: {
      account_id: accountId,
      version: state.version,
      reconciliation_status: state.reconciliation_status,
      open_gap_count: state.open_gap_count,
      gaps: state.gaps,
      projected: projected.applied,
    },
  };
}
