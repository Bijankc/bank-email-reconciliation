import { DurableObject } from "cloudflare:workers";

/**
 * The authoritative per-account ledger (CP). One instance per account_id, so
 * every insert-plus-adjacency-recompute for an account is serialized by
 * construction and the read-modify-write can never interleave.
 *
 * Phase 0 establishes the SQLite schema and the version counter only. The chain
 * check, the gap lifecycle, and the alarm arrive in Phase 3.
 */

/** Bumped whenever the DO's own table layout changes. */
const LEDGER_SCHEMA_VERSION = 1;

export class AccountLedger extends DurableObject<Env> {
  private readonly db: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.db = ctx.storage.sql;
    // blockConcurrencyWhile keeps any request from observing a half-built
    // schema: nothing else runs on this object until the tables exist.
    ctx.blockConcurrencyWhile(async () => this.migrate());
  }

  private migrate(): void {
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
        confirmed_at      TEXT,
        accepted_at       TEXT,
        accept_reason     TEXT
      );
    `);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_gaps_status ON gaps (status);`);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);

    // `version` is the monotonic projection version that guards D1 writes.
    this.db.exec(
      `INSERT OR IGNORE INTO meta (key, value) VALUES ('version', '0'), ('ledger_schema_version', ?);`,
      String(LEDGER_SCHEMA_VERSION),
    );
  }

  private readMeta(key: string): string | null {
    const row = this.db.exec<{ value: string }>(
      `SELECT value FROM meta WHERE key = ?;`,
      key,
    ).toArray()[0];
    return row?.value ?? null;
  }

  /**
   * Phase 0 smoke check: proves the object is reachable, its schema is built,
   * and its counters are readable. Replaced by the real surface in Phase 3.
   */
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
