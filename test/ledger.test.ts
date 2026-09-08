import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

// The ledger's reconciliation behaviour arrives in Phase 3. What is asserted
// here is that the object exists, builds its schema, and is addressable per
// account - the property the whole CP story rests on.

function ledgerFor(accountId: string) {
  return env.ACCOUNT_LEDGER.get(env.ACCOUNT_LEDGER.idFromName(accountId));
}

const INSERT_SEED = `INSERT INTO events
   (event_id, occurred_at, direction, amount_paisa, reported_balance_paisa, applied_at)
 VALUES ('NABIL:seed', '2026-03-12T10:05:00Z', 'DEBIT', 125000, 606055, '2026-03-12T10:06:00Z');`;

const INSERT_ZERO_AMOUNT = `INSERT INTO events
   (event_id, occurred_at, direction, amount_paisa, reported_balance_paisa, applied_at)
 VALUES ('NIMB:bad-amount', '2026-03-12T09:14:22Z', 'DEBIT', 0, 731055, '2026-03-12T09:16:00Z');`;

const INSERT_BAD_DIRECTION = `INSERT INTO events
   (event_id, occurred_at, direction, amount_paisa, reported_balance_paisa, applied_at)
 VALUES ('NIMB:bad-direction', '2026-03-12T09:14:22Z', 'SIDEWAYS', 145000, 731055, '2026-03-12T09:16:00Z');`;

const INSERT_DUPLICATE = `INSERT INTO events
   (event_id, occurred_at, direction, amount_paisa, reported_balance_paisa, applied_at)
 VALUES ('NIMB:88213047qLmT', '2026-03-12T09:14:22Z', 'DEBIT', 145000, 731055, '2026-03-12T09:16:00Z');`;

describe("AccountLedger", () => {
  it("builds its schema and reports an empty ledger", async () => {
    const status = await ledgerFor("NABIL:220XXXXXX881904").status();

    expect(status.ok).toBe(true);
    expect(status.ledger_schema_version).toBe(1);
    expect(status.version).toBe(0);
    expect(status.event_count).toBe(0);
    expect(status.gap_count).toBe(0);
  });

  it("gives each account_id its own isolated object", async () => {
    const first = ledgerFor("NABIL:220XXXXXX881904");
    const second = ledgerFor("NIMB:099XX4417");

    await runInDurableObject(first, (_instance, state) => {
      state.storage.sql.exec(INSERT_SEED);
    });

    // One account's history must not be visible from another's ledger.
    expect((await first.status()).event_count).toBe(1);
    expect((await second.status()).event_count).toBe(0);
  });

  it("enforces the money and direction constraints in its own schema", async () => {
    const ledger = ledgerFor("NIMB:constraint-check");

    await runInDurableObject(ledger, (_instance, state) => {
      // A zero or negative amount is not a transaction.
      expect(() => state.storage.sql.exec(INSERT_ZERO_AMOUNT)).toThrow();
      expect(() => state.storage.sql.exec(INSERT_BAD_DIRECTION)).toThrow();
    });

    expect((await ledger.status()).event_count).toBe(0);
  });

  it("dedups on event_id as a primary key constraint", async () => {
    const ledger = ledgerFor("NIMB:dedup-check");

    await runInDurableObject(ledger, (_instance, state) => {
      state.storage.sql.exec(INSERT_DUPLICATE);
      // The re-delivered email is caught by the schema, not by a lookup.
      expect(() => state.storage.sql.exec(INSERT_DUPLICATE)).toThrow();
    });

    expect((await ledger.status()).event_count).toBe(1);
  });
});
