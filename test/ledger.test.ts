import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { TxnEvent } from "../src/types";

/**
 * The reconciliation core. This is the file that proves the README's hardest
 * claims, so the five properties spec 12 names are each asserted directly:
 * a duplicate changes nothing, out-of-order delivery still converges, a skipped
 * transaction opens a gap of the exact right size, a late arrival closes it, and
 * the alarm promotes a gap the window has outlived so it can be re-anchored.
 *
 * Every account number, reference and merchant below is invented.
 */

function ledgerFor(accountId: string) {
  return env.ACCOUNT_LEDGER.get(env.ACCOUNT_LEDGER.idFromName(accountId));
}

/**
 * A three-transaction chain on one account, in true order:
 *
 *   e1  DEBIT  1000.00  ->  9000.00   (the anchor)
 *   e2  DEBIT    50.00  ->  8950.00
 *   e3  DEBIT    25.00  ->  8925.00
 *
 * Leaving e2 out makes the e1 -> e3 adjacency short by exactly 5000 paisa,
 * which is the missing debit.
 */
function event(
  id: string,
  occurredAt: string,
  amountPaisa: number,
  balancePaisa: number,
  direction: TxnEvent["direction"] = "DEBIT",
): TxnEvent {
  return {
    event_id: `NIMB:${id}`,
    event_id_method: "reference",
    account_id: "NIMB:099XX4417",
    account_label: "099XX4417",
    bank: "NIMB",
    direction,
    amount_paisa: amountPaisa,
    reported_balance_paisa: balancePaisa,
    occurred_at: occurredAt,
    merchant: "invented merchant",
    reference: id,
    source_channel: "email",
    schema_version: 1,
  };
}

const E1 = event("e1", "2026-03-12T09:00:00Z", 100000, 900000);
const E2 = event("e2", "2026-03-12T10:00:00Z", 5000, 895000);
const E3 = event("e3", "2026-03-12T11:00:00Z", 2500, 892500);

/** A fresh, isolated ledger per test, so no test depends on another running. */
let counter = 0;
function freshLedger() {
  counter += 1;
  return ledgerFor(`NIMB:case-${counter}`);
}

describe("AccountLedger schema", () => {
  it("builds its schema and reports an empty ledger", async () => {
    const status = await freshLedger().status();

    expect(status.ok).toBe(true);
    expect(status.ledger_schema_version).toBe(2);
    expect(status.version).toBe(0);
    expect(status.event_count).toBe(0);
    expect(status.gap_count).toBe(0);
  });

  it("gives each account_id its own isolated object", async () => {
    const first = ledgerFor("NIMB:isolation-a");
    const second = ledgerFor("NIMB:isolation-b");

    await first.apply(E1);

    // One account's history must not be visible from another's ledger.
    expect((await first.status()).event_count).toBe(1);
    expect((await second.status()).event_count).toBe(0);
  });

  it("enforces the money and direction constraints in its own schema", async () => {
    const ledger = freshLedger();

    await runInDurableObject(ledger, (_instance, state) => {
      // A zero amount is not a transaction, and there are only two directions.
      expect(() =>
        state.storage.sql.exec(
          `INSERT INTO events (event_id, occurred_at, direction, amount_paisa,
             reported_balance_paisa, applied_at)
           VALUES ('x', '2026-03-12T09:00:00Z', 'DEBIT', 0, 900000, '2026-03-12T09:00:01Z');`,
        ),
      ).toThrow();
      expect(() =>
        state.storage.sql.exec(
          `INSERT INTO events (event_id, occurred_at, direction, amount_paisa,
             reported_balance_paisa, applied_at)
           VALUES ('y', '2026-03-12T09:00:00Z', 'SIDEWAYS', 100, 900000, '2026-03-12T09:00:01Z');`,
        ),
      ).toThrow();
    });
  });
});

describe("the chain", () => {
  it("reads NEW until there are two events to relate", async () => {
    const ledger = freshLedger();

    const first = await ledger.apply(E1);

    // A single event is an anchor, not a relationship. Nothing is reconciled
    // or unreconciled yet.
    expect(first.state.reconciliation_status).toBe("NEW");
    expect(first.state.event_count).toBe(1);
    expect(first.state.current_balance_paisa).toBe(900000);
  });

  it("reconciles a chain that adds up", async () => {
    const ledger = freshLedger();

    await ledger.apply(E1);
    await ledger.apply(E2);
    const state = (await ledger.apply(E3)).state;

    expect(state.reconciliation_status).toBe("RECONCILED");
    expect(state.event_count).toBe(3);
    expect(state.open_gap_count).toBe(0);
    expect(state.current_balance_paisa).toBe(892500);
    expect(state.last_event_at).toBe("2026-03-12T11:00:00Z");
  });

  it("marks each adjacency on the timeline", async () => {
    const ledger = freshLedger();
    await ledger.apply(E1);
    await ledger.apply(E2);

    const { timeline } = await ledger.snapshot();

    // The first event has nothing before it, so it is neither chained nor gapped.
    expect(timeline[0].chains).toBeNull();
    expect(timeline[0].delta_paisa).toBeNull();
    expect(timeline[1].chains).toBe(true);
    expect(timeline[1].expected_balance_paisa).toBe(895000);
    expect(timeline[1].delta_paisa).toBe(0);
  });

  it("records the account identity from the first event", async () => {
    const ledger = freshLedger();

    const state = (await ledger.apply(E1)).state;

    expect(state.bank).toBe("NIMB");
    expect(state.account_label).toBe("099XX4417");
    expect(state.account_id).toBe("NIMB:099XX4417");
  });
});

describe("1. a duplicate email changes nothing", () => {
  it("leaves the balance and the transaction count alone and counts the delivery", async () => {
    const ledger = freshLedger();
    await ledger.apply(E1);
    const before = (await ledger.apply(E2)).state;

    const again = await ledger.apply(E2);

    expect(again.outcome).toBe("duplicate");
    expect(again.delivery_count).toBe(2);
    expect(again.state.event_count).toBe(before.event_count);
    expect(again.state.current_balance_paisa).toBe(before.current_balance_paisa);
    expect(again.state.reconciliation_status).toBe(before.reconciliation_status);
  });

  it("still moves the version, because the delivery count is state", async () => {
    // The dashboard shows deliveries. If the version did not move, the D1
    // projection guard would drop the update and the counter would never
    // appear to increment.
    const ledger = freshLedger();
    await ledger.apply(E1);
    const before = (await ledger.apply(E2)).state.version;

    const after = (await ledger.apply(E2)).state.version;

    expect(after).toBeGreaterThan(before);
  });

  it("keeps the first delivery when a redelivery disagrees about the money", async () => {
    // Same id, different amount: a reused bank reference or a hash collision.
    // Rewriting history on a redelivery would be worse than keeping the first.
    const ledger = freshLedger();
    await ledger.apply(E1);
    await ledger.apply(E2);

    const conflicting = { ...E2, amount_paisa: 9999, reported_balance_paisa: 1 };
    const result = await ledger.apply(conflicting);

    expect(result.outcome).toBe("duplicate");
    expect(result.state.current_balance_paisa).toBe(895000);
  });

  it("counts a third delivery", async () => {
    const ledger = freshLedger();
    await ledger.apply(E1);
    await ledger.apply(E2);
    await ledger.apply(E2);

    expect((await ledger.apply(E2)).delivery_count).toBe(3);
  });
});

describe("2. out-of-order delivery still converges", () => {
  it("reconciles when the later transaction arrives first", async () => {
    const ledger = freshLedger();

    // Arrival order is the reverse of occurred_at order.
    await ledger.apply(E2);
    const state = (await ledger.apply(E1)).state;

    expect(state.reconciliation_status).toBe("RECONCILED");
    expect(state.current_balance_paisa).toBe(895000);
  });

  it("reaches the same state whatever the arrival order", async () => {
    const forwards = freshLedger();
    const backwards = freshLedger();

    for (const item of [E1, E2, E3]) await forwards.apply(item);
    for (const item of [E3, E2, E1]) await backwards.apply(item);

    const a = await forwards.state();
    const b = await backwards.state();

    expect(b.reconciliation_status).toBe(a.reconciliation_status);
    expect(b.current_balance_paisa).toBe(a.current_balance_paisa);
    expect(b.event_count).toBe(a.event_count);
    expect(b.open_gap_count).toBe(a.open_gap_count);
  });

  it("does not hold anything back waiting for a predecessor", async () => {
    // There is no pending buffer: an event out of order is recorded at once and
    // the chain is recomputed around it.
    const ledger = freshLedger();

    const first = await ledger.apply(E3);

    expect(first.outcome).toBe("applied");
    expect(first.state.event_count).toBe(1);
  });
});

describe("3. a skipped transaction opens a gap of the exact right size", () => {
  it("sizes the gap at the missing movement", async () => {
    const ledger = freshLedger();

    await ledger.apply(E1);
    const state = (await ledger.apply(E3)).state;

    expect(state.reconciliation_status).toBe("PENDING_REVIEW");
    expect(state.open_gap_count).toBe(1);
    expect(state.gaps).toHaveLength(1);
    // Expected 900000 - 2500 = 897500, reported 892500. The 5000 difference is
    // exactly the debit in E2 that never arrived.
    expect(state.gaps[0].delta_paisa).toBe(-5000);
    expect(state.gaps[0].status).toBe("PENDING_GAP");
    expect(state.gaps[0].after_event_id).toBe("NIMB:e1");
    expect(state.gaps[0].before_event_id).toBe("NIMB:e3");
  });

  it("schedules the window alarm when the gap opens", async () => {
    const ledger = freshLedger();
    await ledger.apply(E1);
    await ledger.apply(E3);

    const alarm = await runInDurableObject(ledger, (_instance, state) =>
      state.storage.getAlarm(),
    );

    expect(alarm).not.toBeNull();
  });

  it("marks the failing adjacency on the timeline", async () => {
    const ledger = freshLedger();
    await ledger.apply(E1);
    await ledger.apply(E3);

    const { timeline, gaps } = await ledger.snapshot();

    expect(timeline[1].chains).toBe(false);
    expect(timeline[1].delta_paisa).toBe(-5000);
    expect(timeline[1].gap_id).toBe(gaps[0].gap_id);
  });
});

describe("4. a late email closes the gap", () => {
  it("closes the gap and reconciles the account", async () => {
    const ledger = freshLedger();
    await ledger.apply(E1);
    await ledger.apply(E3);

    const state = (await ledger.apply(E2)).state;

    expect(state.reconciliation_status).toBe("RECONCILED");
    expect(state.open_gap_count).toBe(0);
    expect(state.gaps).toHaveLength(0);
    expect(state.event_count).toBe(3);
  });

  it("clears the alarm once nothing is pending", async () => {
    const ledger = freshLedger();
    await ledger.apply(E1);
    await ledger.apply(E3);
    await ledger.apply(E2);

    const alarm = await runInDurableObject(ledger, (_instance, state) =>
      state.storage.getAlarm(),
    );

    expect(alarm).toBeNull();
  });

  it("opens a smaller gap when the late email only partly explains the hole", async () => {
    const ledger = freshLedger();
    await ledger.apply(E1);
    await ledger.apply(E3);

    // A debit of 30.00 where 50.00 was missing: the hole shrinks rather than closing.
    const partial = event("e2partial", "2026-03-12T10:00:00Z", 3000, 897000);
    const state = (await ledger.apply(partial)).state;

    expect(state.reconciliation_status).toBe("PENDING_REVIEW");
    expect(state.gaps).toHaveLength(1);
    expect(state.gaps[0].after_event_id).toBe("NIMB:e2partial");
    expect(state.gaps[0].delta_paisa).toBe(-2000);
  });
});

describe("5. the window, the alarm, and re-anchoring", () => {
  /** Pull a pending gap's deadline into the past so the real alarm is due. */
  async function backdateWindow(ledger: ReturnType<typeof ledgerFor>) {
    await runInDurableObject(ledger, (_instance, state) => {
      state.storage.sql.exec(
        `UPDATE gaps SET promote_at = '2020-01-01T00:00:00Z' WHERE status = 'PENDING_GAP';`,
      );
    });
  }

  it("promotes a pending gap to confirmed when the alarm fires", async () => {
    const ledger = freshLedger();
    await ledger.apply(E1);
    await ledger.apply(E3);
    await backdateWindow(ledger);

    const ran = await runDurableObjectAlarm(ledger);
    const state = await ledger.state();

    // The alarm was really scheduled and really executed - no external
    // scheduler, no cron worker.
    expect(ran).toBe(true);
    expect(state.reconciliation_status).toBe("GAP_CONFIRMED");
    expect(state.gaps[0].status).toBe("CONFIRMED_GAP");
    expect(state.gaps[0].confirmed_at).not.toBeNull();
  });

  it("leaves a gap alone while it is still inside its window", async () => {
    const ledger = freshLedger();
    await ledger.apply(E1);
    await ledger.apply(E3);

    await runDurableObjectAlarm(ledger);
    const state = await ledger.state();

    expect(state.gaps[0].status).toBe("PENDING_GAP");
  });

  it("forces the window for the demo without waiting 48 hours", async () => {
    const ledger = freshLedger();
    await ledger.apply(E1);
    await ledger.apply(E3);

    const state = await ledger.forceWindow();

    expect(state.gaps[0].status).toBe("CONFIRMED_GAP");
    expect(state.reconciliation_status).toBe("GAP_CONFIRMED");
  });

  it("accepts a confirmed gap and reconciles the account again", async () => {
    const ledger = freshLedger();
    await ledger.apply(E1);
    await ledger.apply(E3);
    const confirmed = await ledger.forceWindow();

    const accepted = await ledger.acceptGap(
      confirmed.gaps[0].gap_id,
      "statement checked by hand; the email never arrived",
    );

    expect(accepted.ok).toBe(true);
    expect(accepted.gap?.status).toBe("ACCEPTED_GAP");
    expect(accepted.gap?.accept_reason).toBe(
      "statement checked by hand; the email never arrived",
    );
    // The discontinuity is recorded, not erased, but it no longer counts
    // against the account.
    expect(accepted.state.reconciliation_status).toBe("RECONCILED");
    expect(accepted.state.open_gap_count).toBe(0);
    expect(accepted.state.gaps).toHaveLength(1);
  });

  it("refuses to accept a gap that is still pending", async () => {
    // Accepting inside the window throws away the one mechanism that
    // distinguishes a late email from a lost one.
    const ledger = freshLedger();
    await ledger.apply(E1);
    const opened = (await ledger.apply(E3)).state;

    const result = await ledger.acceptGap(opened.gaps[0].gap_id, "too soon");

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/CONFIRMED_GAP/);
    expect(result.state.gaps[0].status).toBe("PENDING_GAP");
  });

  it("is idempotent when the same accept is retried", async () => {
    const ledger = freshLedger();
    await ledger.apply(E1);
    await ledger.apply(E3);
    const confirmed = await ledger.forceWindow();
    const gapId = confirmed.gaps[0].gap_id;

    await ledger.acceptGap(gapId, "first");
    const second = await ledger.acceptGap(gapId, "second");

    expect(second.ok).toBe(true);
    expect(second.gap?.accept_reason).toBe("first");
  });

  it("reports an unknown gap rather than throwing", async () => {
    const result = await freshLedger().acceptGap("0000000000000000", null);

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/no gap/);
  });

  it("does not auto-close a confirmed gap when the late email finally arrives", async () => {
    // Silently reopening history the operator has already been told about is
    // how a reconciliation tool loses trust. It is surfaced, not acted on.
    const ledger = freshLedger();
    await ledger.apply(E1);
    await ledger.apply(E3);
    await ledger.forceWindow();

    const state = (await ledger.apply(E2)).state;

    expect(state.gaps).toHaveLength(1);
    expect(state.gaps[0].status).toBe("CONFIRMED_GAP");
    expect(state.gaps[0].fillable_at).not.toBeNull();
    expect(state.reconciliation_status).toBe("GAP_CONFIRMED");
  });
});

describe("same-minute ordering", () => {
  // Nabil stamps to the minute, so two transactions in one minute tie on
  // occurred_at and the log alone cannot say which came first.
  const anchor = event("m0", "2026-03-12T14:00:00Z", 100000, 900000);
  const firstInMinute = event("m2", "2026-03-12T14:05:00Z", 5000, 895000);
  const secondInMinute = event("m1", "2026-03-12T14:05:00Z", 2500, 892500);

  it("recovers the true order from the balances", async () => {
    const ledger = freshLedger();
    await ledger.apply(anchor);
    // Sorted by event_id these land the wrong way round: m1 before m2.
    await ledger.apply(secondInMinute);
    await ledger.apply(firstInMinute);

    const snapshot = await ledger.snapshot();

    expect(snapshot.reconciliation_status).toBe("RECONCILED");
    expect(snapshot.timeline.map((entry) => entry.event_id)).toEqual([
      "NIMB:m0",
      "NIMB:m2",
      "NIMB:m1",
    ]);
    expect(snapshot.current_balance_paisa).toBe(892500);
  });

  it("still reports a gap when no arrangement of the tie chains", async () => {
    const ledger = freshLedger();
    await ledger.apply(anchor);
    await ledger.apply(firstInMinute);
    // 25.00 debited but the balance drops by 40.00: nothing reorders that away.
    await ledger.apply(event("m3", "2026-03-12T14:05:00Z", 2500, 891000));

    const state = await ledger.state();

    expect(state.reconciliation_status).toBe("PENDING_REVIEW");
    expect(state.open_gap_count).toBe(1);
  });
});

describe("the version counter", () => {
  it("rises on every state change and never falls", async () => {
    const ledger = freshLedger();
    const seen: number[] = [];

    seen.push((await ledger.apply(E1)).state.version);
    seen.push((await ledger.apply(E3)).state.version);
    seen.push((await ledger.apply(E3)).state.version);
    seen.push((await ledger.forceWindow()).version);
    const confirmed = await ledger.state();
    seen.push((await ledger.acceptGap(confirmed.gaps[0].gap_id, "x")).state.version);

    expect(seen).toEqual([...seen].sort((a, b) => a - b));
    expect(new Set(seen).size).toBe(seen.length);
  });

  it("does not move on a pure read", async () => {
    const ledger = freshLedger();
    await ledger.apply(E1);

    const before = (await ledger.state()).version;
    await ledger.snapshot();
    await ledger.state();

    expect((await ledger.state()).version).toBe(before);
  });
});
