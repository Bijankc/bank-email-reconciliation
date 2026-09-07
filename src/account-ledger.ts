import { DurableObject } from "cloudflare:workers";
import { evaluateChain, type ChainMarks } from "./chain";
import { projectAccount } from "./projection";
import type { Bank, Direction, TxnEvent } from "./types";

/**
 * The authoritative per-account ledger (CP). One instance per account_id, so
 * every insert-plus-adjacency-recompute for an account is serialized by
 * construction and the read-modify-write can never interleave.
 *
 * The model has no per-transaction state machine, because a transaction is a
 * one-shot fact. What is stateful is the relationship between adjacent
 * transactions: reconciliation is a property of adjacencies, not of events
 * (spec 6.1). That is why nothing is ever held in a pending buffer - every
 * deduped event is recorded immediately and the chain is recomputed over the
 * sorted log, so a late email simply slots into its occurred_at position and
 * the two adjacencies it creates are re-evaluated.
 */

/** Bumped whenever the DO table layout changes. */
const LEDGER_SCHEMA_VERSION = 2;

/**
 * How long a detected mismatch stays PENDING_GAP before it is treated as real.
 * A mismatch has two indistinguishable causes at detection time - an email that
 * is late, and one that will never arrive - so the window is the honest way to
 * tell them apart: wait, and see whether the hole fills (spec 6.3).
 */
export const GAP_WINDOW_MS = 48 * 60 * 60 * 1000;

export type GapStatus = "PENDING_GAP" | "CONFIRMED_GAP" | "ACCEPTED_GAP";

export type ReconciliationStatus =
  | "NEW"
  | "RECONCILED"
  | "PENDING_REVIEW"
  | "GAP_CONFIRMED";

/**
 * A row as SQLite hands it back. The index signature is what `exec<T>` requires
 * of a result type; the public shapes below deliberately do not carry it.
 */
interface EventRow {
  [column: string]: SqlStorageValue;
  event_id: string;
  occurred_at: string;
  direction: Direction;
  amount_paisa: number;
  reported_balance_paisa: number;
  merchant: string | null;
  reference: string | null;
  applied_at: string;
  deliveries: number;
}

export interface GapRecord {
  [column: string]: SqlStorageValue;
  gap_id: string;
  after_event_id: string | null;
  before_event_id: string;
  delta_paisa: number;
  status: GapStatus;
  detected_at: string;
  /** When the window elapses and the alarm may promote this gap. */
  promote_at: string | null;
  confirmed_at: string | null;
  accepted_at: string | null;
  accept_reason: string | null;
  /**
   * Set when a CONFIRMED_GAP stops looking like a gap because a late email
   * arrived. Surfaced to the operator rather than acted on; see spec 6.4.
   */
  fillable_at: string | null;
}

/** One event plus what the chain says about the adjacency that ends at it. */
export interface TimelineEntry extends ChainMarks {
  event_id: string;
  occurred_at: string;
  direction: Direction;
  amount_paisa: number;
  reported_balance_paisa: number;
  merchant: string | null;
  reference: string | null;
  applied_at: string;
  deliveries: number;
  gap_id: string | null;
}

export interface LedgerState {
  account_id: string;
  bank: Bank | null;
  account_label: string | null;
  /** Monotonic. Guards the D1 projection: a stale write matches zero rows. */
  version: number;
  current_balance_paisa: number | null;
  last_event_at: string | null;
  reconciliation_status: ReconciliationStatus;
  open_gap_count: number;
  event_count: number;
  gaps: GapRecord[];
  created_at: string | null;
}

export interface ApplyResult {
  outcome: "applied" | "duplicate";
  delivery_count: number;
  state: LedgerState;
}

export interface AcceptResult {
  ok: boolean;
  error?: string;
  gap?: GapRecord;
  state: LedgerState;
}

export interface LedgerSnapshot extends LedgerState {
  timeline: TimelineEntry[];
}

const encoder = new TextEncoder();

/**
 * A gap is identified by the pair of events it sits between, so re-detecting
 * the same gap finds the same row instead of opening a second one. The pair is
 * hashed rather than concatenated because gap_id travels in a URL path segment
 * (spec 8), and a bank reference is not guaranteed to be path-safe. The cost is
 * an opaque id; the bounding event ids are columns, so nothing is lost.
 *
 * The NUL separator is the same trick the hash-derived event_id uses: without
 * it, two different pairs can produce the same input string and therefore the
 * same gap.
 */
async function deriveGapId(after: string, before: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(`${after}\u0000${before}`),
  );
  return Array.from(new Uint8Array(digest))
    .slice(0, 8)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export class AccountLedger extends DurableObject<Env> {
  private readonly db: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.db = ctx.storage.sql;
    // blockConcurrencyWhile keeps any request from observing a half-built
    // schema: nothing else runs on this object until the tables exist.
    ctx.blockConcurrencyWhile(async () => this.migrate());
  }

  // ---------------------------------------------------------------------------
  // schema
  // ---------------------------------------------------------------------------

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        event_id                 TEXT PRIMARY KEY,
        occurred_at              TEXT NOT NULL,
        direction                TEXT NOT NULL CHECK (direction IN ('DEBIT','CREDIT')),
        amount_paisa             INTEGER NOT NULL CHECK (amount_paisa > 0),
        reported_balance_paisa   INTEGER NOT NULL,
        merchant                 TEXT,
        reference                TEXT,
        applied_at               TEXT NOT NULL,
        deliveries               INTEGER NOT NULL DEFAULT 1
      );
    `);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_events_time ON events (occurred_at);`);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS gaps (
        gap_id            TEXT PRIMARY KEY,
        after_event_id    TEXT,
        before_event_id   TEXT NOT NULL,
        delta_paisa       INTEGER NOT NULL,
        status            TEXT NOT NULL CHECK (status IN ('PENDING_GAP','CONFIRMED_GAP','ACCEPTED_GAP')),
        detected_at       TEXT NOT NULL,
        promote_at        TEXT,
        confirmed_at      TEXT,
        accepted_at       TEXT,
        accept_reason     TEXT,
        fillable_at       TEXT
      );
    `);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_gaps_status ON gaps (status);`);

    // Objects created before schema v2 already have a gaps table without these
    // columns. CREATE TABLE IF NOT EXISTS will not add them, and a Durable
    // Object cannot be dropped and rebuilt without losing the ledger it holds.
    this.ensureColumn("gaps", "promote_at", "promote_at TEXT");
    this.ensureColumn("gaps", "fillable_at", "fillable_at TEXT");

    this.db.exec(
      `INSERT OR IGNORE INTO meta (key, value) VALUES ('version', '0');`,
    );
    this.writeMeta("ledger_schema_version", String(LEDGER_SCHEMA_VERSION));
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    const columns = this.db
      .exec<{ name: string }>(`PRAGMA table_info(${table});`)
      .toArray();
    if (!columns.some((row) => row.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition};`);
    }
  }

  // ---------------------------------------------------------------------------
  // meta
  // ---------------------------------------------------------------------------

  private readMeta(key: string): string | null {
    const row = this.db
      .exec<{ value: string }>(`SELECT value FROM meta WHERE key = ?;`, key)
      .toArray()[0];
    return row?.value ?? null;
  }

  private writeMeta(key: string, value: string): void {
    this.db.exec(
      `INSERT INTO meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value;`,
      key,
      value,
    );
  }

  /**
   * Every state change bumps this. The consumer sends it to D1 with a
   * compare-and-set, so an out-of-order projection write matches zero rows and
   * disappears instead of overwriting fresher state (spec 7.2).
   */
  private bumpVersion(): number {
    const next = Number(this.readMeta("version") ?? 0) + 1;
    this.writeMeta("version", String(next));
    return next;
  }

  // ---------------------------------------------------------------------------
  // reading the chain
  // ---------------------------------------------------------------------------

  /**
   * The event log in chain order, with each adjacency evaluated.
   *
   * Everything the ledger reports is computed from this one function, so there
   * is no stored balance and no stored reconciliation flag that could drift
   * from the events they are meant to summarize.
   */
  private timeline(): TimelineEntry[] {
    const rows = this.db.exec<EventRow>(`SELECT * FROM events;`).toArray();
    const evaluated = evaluateChain(rows);

    const gapByPair = new Map<string, string>();
    for (const gap of this.allGaps()) {
      gapByPair.set(
        `${gap.after_event_id} ${gap.before_event_id}`,
        gap.gap_id,
      );
    }

    return evaluated.map((entry, position) => ({
      ...entry,
      gap_id:
        position === 0
          ? null
          : gapByPair.get(
              `${evaluated[position - 1].event_id} ${entry.event_id}`,
            ) ?? null,
    })) as TimelineEntry[];
  }

  private allGaps(): GapRecord[] {
    return this.db
      .exec<GapRecord>(`SELECT * FROM gaps ORDER BY detected_at ASC;`)
      .toArray();
  }

  private buildState(): LedgerState {
    const timeline = this.timeline();
    const gaps = this.allGaps();

    // An accepted gap is a discontinuity the operator has taken responsibility
    // for, so it no longer counts against the account. Only the two live
    // statuses are open.
    const pending = gaps.filter((gap) => gap.status === "PENDING_GAP").length;
    const confirmed = gaps.filter((gap) => gap.status === "CONFIRMED_GAP").length;

    let status: ReconciliationStatus;
    if (timeline.length < 2) {
      // Nothing to chain yet: a single event is an anchor, not a relationship.
      status = "NEW";
    } else if (confirmed > 0) {
      status = "GAP_CONFIRMED";
    } else if (pending > 0) {
      status = "PENDING_REVIEW";
    } else {
      status = "RECONCILED";
    }

    const last = timeline[timeline.length - 1] ?? null;

    return {
      account_id: this.readMeta("account_id") ?? "",
      bank: (this.readMeta("bank") as Bank | null) ?? null,
      account_label: this.readMeta("account_label"),
      version: Number(this.readMeta("version") ?? 0),
      current_balance_paisa: last?.reported_balance_paisa ?? null,
      last_event_at: last?.occurred_at ?? null,
      reconciliation_status: status,
      open_gap_count: pending + confirmed,
      event_count: timeline.length,
      gaps,
      created_at: this.readMeta("created_at"),
    };
  }

  // ---------------------------------------------------------------------------
  // recomputing gaps
  // ---------------------------------------------------------------------------

  /**
   * Re-evaluate every adjacency and reconcile the gaps table against it.
   *
   * The whole log is walked rather than only the adjacencies around the new
   * event. An insert can invalidate a gap that neither of its bounding events
   * belongs to only in ways this pass would catch anyway, and a full walk
   * cannot leave a stale gap behind the way a targeted patch can. The cost is
   * linear in the account history per event, which is the trade this makes
   * deliberately: correctness of the heart of the system over throughput on an
   * account with tens of thousands of transactions.
   */
  private async recomputeGaps(now: string): Promise<void> {
    const timeline = this.timeline();

    const failing = new Map<string, { after: string; before: string; delta: number }>();
    for (let index = 1; index < timeline.length; index += 1) {
      const entry = timeline[index];
      if (entry.delta_paisa !== null && entry.delta_paisa !== 0) {
        const after = timeline[index - 1].event_id;
        failing.set(`${after}\u0000${entry.event_id}`, {
          after,
          before: entry.event_id,
          delta: entry.delta_paisa,
        });
      }
    }

    for (const gap of this.allGaps()) {
      const pair = `${gap.after_event_id}\u0000${gap.before_event_id}`;
      const stillFailing = failing.get(pair);

      if (gap.status === "PENDING_GAP") {
        if (stillFailing === undefined) {
          // Either the adjacency now chains, or the two events are no longer
          // adjacent because a late email landed between them. Both mean this
          // gap has been filled: the row is removed rather than kept in a
          // fourth status, because a closed gap is not a gap.
          this.db.exec(`DELETE FROM gaps WHERE gap_id = ?;`, gap.gap_id);
        } else if (stillFailing.delta !== gap.delta_paisa) {
          this.db.exec(
            `UPDATE gaps SET delta_paisa = ? WHERE gap_id = ?;`,
            stillFailing.delta,
            gap.gap_id,
          );
        }
        failing.delete(pair);
        continue;
      }

      if (gap.status === "CONFIRMED_GAP") {
        // A confirmed gap is never closed automatically. Silently reopening
        // history the operator has already been told about is how a
        // reconciliation tool loses trust (spec 6.4), so the fact that it now
        // looks fillable is recorded and surfaced instead of acted on.
        if (stillFailing === undefined && gap.fillable_at === null) {
          this.db.exec(
            `UPDATE gaps SET fillable_at = ? WHERE gap_id = ?;`,
            now,
            gap.gap_id,
          );
        } else if (stillFailing !== undefined && gap.fillable_at !== null) {
          this.db.exec(
            `UPDATE gaps SET fillable_at = NULL WHERE gap_id = ?;`,
            gap.gap_id,
          );
        }
      }

      // ACCEPTED_GAP is terminal and is left exactly as the operator left it.
      failing.delete(pair);
    }

    const promoteAt = new Date(Date.parse(now) + GAP_WINDOW_MS).toISOString();
    for (const entry of failing.values()) {
      const gapId = await deriveGapId(entry.after, entry.before);
      this.db.exec(
        `INSERT INTO gaps (gap_id, after_event_id, before_event_id, delta_paisa,
                           status, detected_at, promote_at)
         VALUES (?, ?, ?, ?, 'PENDING_GAP', ?, ?)
         ON CONFLICT(gap_id) DO UPDATE SET delta_paisa = excluded.delta_paisa;`,
        gapId,
        entry.after,
        entry.before,
        entry.delta,
        now,
        promoteAt,
      );
    }

    await this.scheduleAlarm();
  }

  /**
   * Keep the alarm pointed at the earliest pending deadline. There is one alarm
   * per Durable Object, so it is set to the minimum rather than once per gap,
   * and rescheduled after every promotion.
   */
  private async scheduleAlarm(): Promise<void> {
    const next = this.db
      .exec<{ promote_at: string | null }>(
        `SELECT MIN(promote_at) AS promote_at FROM gaps
          WHERE status = 'PENDING_GAP' AND promote_at IS NOT NULL;`,
      )
      .one();

    if (next.promote_at === null) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    await this.ctx.storage.setAlarm(Date.parse(next.promote_at));
  }

  // ---------------------------------------------------------------------------
  // public surface
  // ---------------------------------------------------------------------------

  /**
   * Record one event. Safe to call repeatedly with the same event: at-least-once
   * delivery means it will be.
   */
  async apply(event: TxnEvent): Promise<ApplyResult> {
    const now = new Date().toISOString();

    if (this.readMeta("account_id") === null) {
      this.writeMeta("account_id", event.account_id);
      this.writeMeta("created_at", now);
    }
    this.writeMeta("bank", event.bank);
    if (event.account_label) this.writeMeta("account_label", event.account_label);

    // Dedup is the primary key, not a lookup. The conflict clause counts the
    // redelivery and touches nothing else, which is the whole "a duplicate
    // email changes nothing" story: same balance, same transaction count, one
    // more delivery.
    const inserted = this.db
      .exec<{ deliveries: number }>(
        `INSERT INTO events (event_id, occurred_at, direction, amount_paisa,
                             reported_balance_paisa, merchant, reference, applied_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(event_id) DO UPDATE SET deliveries = events.deliveries + 1
         RETURNING deliveries;`,
        event.event_id,
        event.occurred_at,
        event.direction,
        event.amount_paisa,
        event.reported_balance_paisa,
        event.merchant,
        event.reference,
        now,
      )
      .one();

    if (inserted.deliveries > 1) {
      const stored = this.db
        .exec<EventRow>(`SELECT * FROM events WHERE event_id = ?;`, event.event_id)
        .one();
      if (
        stored.amount_paisa !== event.amount_paisa ||
        stored.reported_balance_paisa !== event.reported_balance_paisa ||
        stored.direction !== event.direction
      ) {
        // Same id, different money. Either a bank reused a reference or a
        // hash-derived id collided. The first delivery is kept - rewriting
        // history on a redelivery is worse - but this must not pass silently.
        console.warn(
          JSON.stringify({
            at: "ledger.duplicate_mismatch",
            event_id: event.event_id,
            stored: {
              direction: stored.direction,
              amount_paisa: stored.amount_paisa,
              reported_balance_paisa: stored.reported_balance_paisa,
            },
            incoming: {
              direction: event.direction,
              amount_paisa: event.amount_paisa,
              reported_balance_paisa: event.reported_balance_paisa,
            },
          }),
        );
      }

      // The delivery counter is state, and the dashboard shows it, so the
      // version still moves even though the balance does not.
      this.bumpVersion();
      return {
        outcome: "duplicate",
        delivery_count: inserted.deliveries,
        state: this.buildState(),
      };
    }

    await this.recomputeGaps(now);
    this.bumpVersion();

    return { outcome: "applied", delivery_count: 1, state: this.buildState() };
  }

  /**
   * Re-anchor (spec 6.5). An operator accepts a confirmed gap, recording the
   * delta as an accepted discontinuity so the account can read RECONCILED again
   * without the missing email ever arriving.
   */
  async acceptGap(gapId: string, reason: string | null): Promise<AcceptResult> {
    const gap = this.db
      .exec<GapRecord>(`SELECT * FROM gaps WHERE gap_id = ?;`, gapId)
      .toArray()[0];

    if (gap === undefined) {
      return { ok: false, error: `no gap ${gapId} on this account`, state: this.buildState() };
    }
    if (gap.status === "ACCEPTED_GAP") {
      // Idempotent rather than an error: a retried accept must not fail.
      return { ok: true, gap, state: this.buildState() };
    }
    if (gap.status !== "CONFIRMED_GAP") {
      // Accepting a gap that is still inside its window would throw away the
      // one mechanism that distinguishes a late email from a lost one.
      return {
        ok: false,
        error: "only a CONFIRMED_GAP can be accepted; this gap is still PENDING_GAP",
        state: this.buildState(),
      };
    }

    const now = new Date().toISOString();
    this.db.exec(
      `UPDATE gaps SET status = 'ACCEPTED_GAP', accepted_at = ?, accept_reason = ?
        WHERE gap_id = ?;`,
      now,
      reason,
      gapId,
    );
    this.bumpVersion();

    return {
      ok: true,
      gap: this.db.exec<GapRecord>(`SELECT * FROM gaps WHERE gap_id = ?;`, gapId).one(),
      state: this.buildState(),
    };
  }

  /**
   * The window elapsing, driven by the platform rather than by a cron worker or
   * an external scheduler. This is the transition that makes the two-stage
   * lifecycle real: nothing outside the object has to remember to check.
   */
  async alarm(): Promise<void> {
    const now = new Date().toISOString();

    const due = this.db
      .exec<{ gap_id: string }>(
        `SELECT gap_id FROM gaps
          WHERE status = 'PENDING_GAP' AND promote_at IS NOT NULL AND promote_at <= ?;`,
        now,
      )
      .toArray();

    if (due.length > 0) {
      this.db.exec(
        `UPDATE gaps SET status = 'CONFIRMED_GAP', confirmed_at = ?
          WHERE status = 'PENDING_GAP' AND promote_at IS NOT NULL AND promote_at <= ?;`,
        now,
        now,
      );
      this.bumpVersion();
      console.log(
        JSON.stringify({
          at: "ledger.gaps_confirmed",
          account_id: this.readMeta("account_id"),
          gap_ids: due.map((row) => row.gap_id),
        }),
      );
    }

    await this.scheduleAlarm();

    if (due.length > 0) {
      // The object projects itself here, which it does nowhere else. Every other
      // state change arrives on a queue message and the consumer projects it
      // afterwards; this one has no message behind it, so if the alarm did not
      // write to D1 the dashboard would keep showing PENDING_REVIEW until the
      // account's next transaction happened to arrive.
      await projectAccount(this.env, this.buildState());
    }
  }

  /**
   * Force the window shut without waiting 48 hours. This exists for the
   * simulator panel (spec 10), which has to be able to demonstrate the
   * PENDING to CONFIRMED transition inside a demo rather than across two days.
   * It promotes exactly what the alarm would promote, so the demo shows the
   * real transition and not a mock of it.
   */
  async forceWindow(): Promise<LedgerState> {
    const now = new Date().toISOString();
    const pending = this.db
      .exec<{ n: number }>(
        `SELECT COUNT(*) AS n FROM gaps WHERE status = 'PENDING_GAP';`,
      )
      .one().n;

    if (pending > 0) {
      this.db.exec(
        `UPDATE gaps SET status = 'CONFIRMED_GAP', confirmed_at = ?
          WHERE status = 'PENDING_GAP';`,
        now,
      );
      this.bumpVersion();
    }

    await this.scheduleAlarm();
    return this.buildState();
  }

  /** The projected state the consumer writes to D1. */
  async state(): Promise<LedgerState> {
    return this.buildState();
  }

  /** State plus the evaluated timeline: the authoritative read behind spec 8. */
  async snapshot(): Promise<LedgerSnapshot> {
    return { ...this.buildState(), timeline: this.timeline() };
  }

  /** Binding smoke check for /health. */
  async status(): Promise<{
    ok: true;
    ledger_schema_version: number;
    version: number;
    event_count: number;
    gap_count: number;
  }> {
    const events = this.db.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM events;`).one().n;
    const gaps = this.db.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM gaps;`).one().n;
    return {
      ok: true,
      ledger_schema_version: Number(this.readMeta("ledger_schema_version") ?? 0),
      version: Number(this.readMeta("version") ?? 0),
      event_count: events,
      gap_count: gaps,
    };
  }
}
