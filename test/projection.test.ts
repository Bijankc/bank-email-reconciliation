import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { LedgerState } from "../src/account-ledger";
import { projectAccount, projectTransaction } from "../src/projection";
import type { TxnEvent } from "../src/types";

/**
 * The version guard is the whole point of this file. D1 is allowed to lag
 * behind the ledger; it is not allowed to go backwards, and the only thing
 * stopping it is a compare-and-set that a stale write has to lose.
 *
 * Every account number and reference below is invented.
 */

let unique = 0;
function accountId(): string {
  unique += 1;
  return `NIMB:proj-${unique}`;
}

function state(overrides: Partial<LedgerState> & { account_id: string }): LedgerState {
  return {
    bank: "NIMB",
    account_label: "099XX4417",
    version: 1,
    current_balance_paisa: 900000,
    last_event_at: "2026-03-12T09:00:00Z",
    reconciliation_status: "NEW",
    open_gap_count: 0,
    event_count: 1,
    gaps: [],
    created_at: "2026-03-12T09:00:01Z",
    ...overrides,
  };
}

// Real gap ids are hashes of globally unique bounding event ids, so they never
// collide across accounts. The fixture keeps that property rather than reusing
// one id, which the D1 primary key would (correctly) reject.
let gapCounter = 0;
function gap(overrides: Record<string, unknown> = {}) {
  gapCounter += 1;
  return {
    gap_id: `gap${String(gapCounter).padStart(13, "0")}`,
    after_event_id: "NIMB:one",
    before_event_id: "NIMB:three",
    delta_paisa: -5000,
    status: "PENDING_GAP" as const,
    detected_at: "2026-03-12T11:00:00Z",
    promote_at: "2026-03-14T11:00:00Z",
    confirmed_at: null,
    accepted_at: null,
    accept_reason: null,
    fillable_at: null,
    ...overrides,
  };
}

function event(id: string, account: string): TxnEvent {
  return {
    event_id: id,
    event_id_method: "reference",
    account_id: account,
    account_label: "099XX4417",
    bank: "NIMB",
    direction: "DEBIT",
    amount_paisa: 100000,
    reported_balance_paisa: 900000,
    occurred_at: "2026-03-12T09:00:00Z",
    merchant: "invented merchant",
    reference: id,
    source_channel: "email",
    schema_version: 1,
  };
}

describe("projectAccount", () => {
  it("creates the account row on the first projection", async () => {
    const id = accountId();

    const result = await projectAccount(env, state({ account_id: id }));
    const row = await env.DB.prepare(
      `SELECT * FROM accounts WHERE account_id = ?1;`,
    )
      .bind(id)
      .first<{ projection_version: number; current_balance_paisa: number }>();

    expect(result.applied).toBe(true);
    expect(row?.projection_version).toBe(1);
    expect(row?.current_balance_paisa).toBe(900000);
  });

  it("applies a newer version", async () => {
    const id = accountId();
    await projectAccount(env, state({ account_id: id }));

    const result = await projectAccount(
      env,
      state({
        account_id: id,
        version: 2,
        current_balance_paisa: 895000,
        reconciliation_status: "RECONCILED",
      }),
    );
    const row = await env.DB.prepare(
      `SELECT * FROM accounts WHERE account_id = ?1;`,
    )
      .bind(id)
      .first<{ projection_version: number; reconciliation_status: string }>();

    expect(result.applied).toBe(true);
    expect(row?.projection_version).toBe(2);
    expect(row?.reconciliation_status).toBe("RECONCILED");
  });

  it("discards a stale write and leaves the row untouched", async () => {
    // A retried delivery overtaken by the next event, or two messages for one
    // account processed out of order. The old state must not win.
    const id = accountId();
    await projectAccount(env, state({ account_id: id, version: 5, current_balance_paisa: 500 }));

    const result = await projectAccount(
      env,
      state({ account_id: id, version: 3, current_balance_paisa: 999999 }),
    );
    const row = await env.DB.prepare(
      `SELECT * FROM accounts WHERE account_id = ?1;`,
    )
      .bind(id)
      .first<{ projection_version: number; current_balance_paisa: number }>();

    expect(result.applied).toBe(false);
    expect(result.storedVersion).toBe(5);
    expect(row?.projection_version).toBe(5);
    expect(row?.current_balance_paisa).toBe(500);
  });

  it("discards a write at the same version", async () => {
    // Strictly greater, not greater-or-equal: a redelivery of the message that
    // wrote this version has nothing new to say.
    const id = accountId();
    await projectAccount(env, state({ account_id: id, version: 4 }));

    const result = await projectAccount(env, state({ account_id: id, version: 4 }));

    expect(result.applied).toBe(false);
  });

  it("replaces the gap set rather than merging into it", async () => {
    // A gap that filled is gone from the ledger and has to be gone here. There
    // is no delete event to carry that news on its own.
    const id = accountId();
    await projectAccount(
      env,
      state({ account_id: id, version: 1, open_gap_count: 1, gaps: [gap()] }),
    );

    await projectAccount(env, state({ account_id: id, version: 2, gaps: [] }));
    const { results } = await env.DB.prepare(
      `SELECT * FROM gaps WHERE account_id = ?1;`,
    )
      .bind(id)
      .all();

    expect(results).toHaveLength(0);
  });

  it("projects the gap bounds the dashboard needs", async () => {
    const id = accountId();

    await projectAccount(
      env,
      state({ account_id: id, open_gap_count: 1, gaps: [gap()] }),
    );
    const row = await env.DB.prepare(`SELECT * FROM gaps WHERE account_id = ?1;`)
      .bind(id)
      .first<{ after_event_id: string; before_event_id: string; delta_paisa: number }>();

    expect(row?.after_event_id).toBe("NIMB:one");
    expect(row?.before_event_id).toBe("NIMB:three");
    expect(row?.delta_paisa).toBe(-5000);
  });

  it("does not touch the gap rows when the write is discarded", async () => {
    const id = accountId();
    await projectAccount(
      env,
      state({ account_id: id, version: 9, open_gap_count: 1, gaps: [gap()] }),
    );

    await projectAccount(env, state({ account_id: id, version: 2, gaps: [] }));
    const { results } = await env.DB.prepare(
      `SELECT * FROM gaps WHERE account_id = ?1;`,
    )
      .bind(id)
      .all();

    expect(results).toHaveLength(1);
  });
});

describe("projectTransaction", () => {
  it("writes the timeline row with its audit key", async () => {
    const id = accountId();
    await projectAccount(env, state({ account_id: id }));

    await projectTransaction(env, event("NIMB:tx-1", id), {
      outcome: "applied",
      delivery_count: 1,
      raw_r2_key: "raw/NIMB:099XX4417/NIMB:tx-1.eml",
      received_at: "2026-03-12T09:00:05Z",
    });
    const row = await env.DB.prepare(
      `SELECT * FROM transactions WHERE event_id = 'NIMB:tx-1';`,
    ).first<{ raw_r2_key: string; outcome: string; delivery_count: number }>();

    expect(row?.raw_r2_key).toBe("raw/NIMB:099XX4417/NIMB:tx-1.eml");
    expect(row?.outcome).toBe("applied");
    expect(row?.delivery_count).toBe(1);
  });

  it("raises the delivery count on a redelivery without changing the outcome", async () => {
    // The row never flips from applied to duplicate: the first delivery is the
    // one that moved the money, and the projection must agree with the ledger.
    const id = accountId();
    await projectAccount(env, state({ account_id: id }));
    const txn = event("NIMB:tx-2", id);
    await projectTransaction(env, txn, {
      outcome: "applied",
      delivery_count: 1,
      raw_r2_key: "k",
      received_at: "2026-03-12T09:00:05Z",
    });

    await projectTransaction(env, txn, {
      outcome: "duplicate",
      delivery_count: 2,
      raw_r2_key: "k",
      received_at: "2026-03-12T09:10:00Z",
    });
    const row = await env.DB.prepare(
      `SELECT * FROM transactions WHERE event_id = 'NIMB:tx-2';`,
    ).first<{ outcome: string; delivery_count: number }>();

    expect(row?.outcome).toBe("applied");
    expect(row?.delivery_count).toBe(2);
  });

  it("never lowers the delivery count", async () => {
    const id = accountId();
    await projectAccount(env, state({ account_id: id }));
    const txn = event("NIMB:tx-3", id);
    await projectTransaction(env, txn, {
      outcome: "applied",
      delivery_count: 3,
      raw_r2_key: "k",
      received_at: "2026-03-12T09:00:05Z",
    });

    await projectTransaction(env, txn, {
      outcome: "duplicate",
      delivery_count: 2,
      raw_r2_key: "k",
      received_at: "2026-03-12T09:00:05Z",
    });
    const row = await env.DB.prepare(
      `SELECT delivery_count FROM transactions WHERE event_id = 'NIMB:tx-3';`,
    ).first<{ delivery_count: number }>();

    expect(row?.delivery_count).toBe(3);
  });
});
