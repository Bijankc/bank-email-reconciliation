import { describe, expect, it } from "vitest";
import { validateTxnEvent } from "../src/validate";

/**
 * /webhook is the one place a caller can hand the engine a transaction the
 * parsers did not build, so these tests are about what the boundary refuses.
 * Every value below is invented.
 */

const VALID = {
  event_id: "NABIL:71104582WxYz",
  account_id: "NABIL:220XXXXXX881904",
  bank: "NABIL",
  direction: "DEBIT",
  amount_paisa: 125000,
  reported_balance_paisa: 606055,
  occurred_at: "2026-03-12T10:05:00Z",
  merchant: "ORCHID STATIONERS PVT. LTD.",
  reference: "71104582WxYz",
  source_channel: "simulator",
  schema_version: 1,
};

/** The field names of everything that went wrong, for compact assertions. */
async function fieldsRejected(body: unknown): Promise<string[]> {
  const result = await validateTxnEvent(body);
  if (result.ok) return [];
  return result.errors.map((error) => error.field);
}

describe("validateTxnEvent", () => {
  it("accepts a well-formed simulator event unchanged", async () => {
    const result = await validateTxnEvent(VALID);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.event).toEqual({
      event_id: "NABIL:71104582WxYz",
      event_id_method: "reference",
      account_id: "NABIL:220XXXXXX881904",
      account_label: "220XXXXXX881904",
      bank: "NABIL",
      direction: "DEBIT",
      amount_paisa: 125000,
      reported_balance_paisa: 606055,
      occurred_at: "2026-03-12T10:05:00Z",
      merchant: "ORCHID STATIONERS PVT. LTD.",
      reference: "71104582WxYz",
      source_channel: "simulator",
      schema_version: 1,
    });
  });

  it("produces the same key set the email parsers produce", async () => {
    // Nothing downstream of ingress should be able to tell the two apart.
    const result = await validateTxnEvent(VALID);
    if (!result.ok) throw new Error("expected valid");

    expect(Object.keys(result.event).sort()).toEqual(
      [
        "account_id",
        "account_label",
        "amount_paisa",
        "bank",
        "direction",
        "event_id",
        "event_id_method",
        "merchant",
        "occurred_at",
        "reference",
        "reported_balance_paisa",
        "schema_version",
        "source_channel",
      ].sort(),
    );
  });

  describe("money is integer paisa or it is not accepted", () => {
    it("rejects a fractional amount", async () => {
      // 2200.5 paisa is not a thing. This is the guard that stops rupees being
      // posted where paisa are expected.
      expect(await fieldsRejected({ ...VALID, amount_paisa: 2200.5 })).toEqual([
        "amount_paisa",
      ]);
    });

    it("rejects an amount sent as a string", async () => {
      expect(await fieldsRejected({ ...VALID, amount_paisa: "125000" })).toEqual([
        "amount_paisa",
      ]);
    });

    it("rejects a zero or negative amount", async () => {
      expect(await fieldsRejected({ ...VALID, amount_paisa: 0 })).toEqual([
        "amount_paisa",
      ]);
      expect(await fieldsRejected({ ...VALID, amount_paisa: -100 })).toEqual([
        "amount_paisa",
      ]);
    });

    it("rejects an amount beyond exact integer range", async () => {
      expect(
        await fieldsRejected({ ...VALID, amount_paisa: Number.MAX_SAFE_INTEGER + 2 }),
      ).toEqual(["amount_paisa"]);
    });

    it("accepts a zero or negative balance", async () => {
      // An overdrawn account is a real state and the events worth seeing most.
      const zero = await validateTxnEvent({ ...VALID, reported_balance_paisa: 0 });
      const negative = await validateTxnEvent({
        ...VALID,
        reported_balance_paisa: -45000,
      });

      expect(zero.ok).toBe(true);
      expect(negative.ok).toBe(true);
    });

    it("rejects a fractional balance", async () => {
      expect(
        await fieldsRejected({ ...VALID, reported_balance_paisa: 606055.5 }),
      ).toEqual(["reported_balance_paisa"]);
    });
  });

  describe("identity", () => {
    it("rejects an account_id whose prefix disagrees with bank", async () => {
      // Otherwise this opens a second ledger for the same real account.
      expect(
        await fieldsRejected({ ...VALID, account_id: "NIMB:220XXXXXX881904" }),
      ).toEqual(["account_id"]);
    });

    it("rejects an account_id that is only a bank prefix", async () => {
      expect(await fieldsRejected({ ...VALID, account_id: "NABIL:" })).toEqual([
        "account_id",
      ]);
    });

    it("derives event_id when the caller omits it", async () => {
      const { event_id: _omitted, ...withoutId } = VALID;
      const result = await validateTxnEvent(withoutId);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.event.event_id).toBe("NABIL:71104582WxYz");
      expect(result.event.event_id_method).toBe("reference");
    });

    it("falls back to a hash id when there is no reference either", async () => {
      const { event_id: _omitted, ...withoutId } = VALID;
      const result = await validateTxnEvent({ ...withoutId, reference: null });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.event.event_id).toMatch(/^NABIL:[0-9a-f]{64}$/);
      expect(result.event.event_id_method).toBe("hash");
    });

    it("posting the same event twice derives the same id", async () => {
      // The dedup story: the caller does not have to know the derivation rule.
      const { event_id: _omitted, ...withoutId } = VALID;
      const first = await validateTxnEvent({ ...withoutId, reference: null });
      const second = await validateTxnEvent({ ...withoutId, reference: null });

      if (!first.ok || !second.ok) throw new Error("expected valid");
      expect(first.event.event_id).toBe(second.event.event_id);
    });

    it("does not trust event_id_method from the body", async () => {
      // The id says "reference" only if it actually is the reference.
      const result = await validateTxnEvent({
        ...VALID,
        event_id: "NABIL:something-else",
        event_id_method: "reference",
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.event.event_id_method).toBe("hash");
    });

    it("rejects an event_id namespaced to the wrong bank", async () => {
      expect(
        await fieldsRejected({ ...VALID, event_id: "NIMB:71104582WxYz" }),
      ).toEqual(["event_id"]);
    });
  });

  describe("provenance and versioning", () => {
    it("forces source_channel to simulator whatever the body claims", async () => {
      const result = await validateTxnEvent({ ...VALID, source_channel: "email" });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.event.source_channel).toBe("simulator");
    });

    it("rejects an event from a schema version it cannot read", async () => {
      expect(await fieldsRejected({ ...VALID, schema_version: 2 })).toEqual([
        "schema_version",
      ]);
    });

    it("ignores additive unknown fields", async () => {
      const result = await validateTxnEvent({ ...VALID, channel_hint: "atm" });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect("channel_hint" in result.event).toBe(false);
    });
  });

  describe("shape", () => {
    it("rejects a non-object body", async () => {
      expect(await fieldsRejected("NABIL")).toEqual(["body"]);
      expect(await fieldsRejected([VALID])).toEqual(["body"]);
      expect(await fieldsRejected(null)).toEqual(["body"]);
    });

    it("rejects an unknown bank and an unknown direction", async () => {
      expect(
        await fieldsRejected({ ...VALID, bank: "OTHER", direction: "TRANSFER" }),
      ).toContain("bank");
      expect(
        await fieldsRejected({ ...VALID, bank: "OTHER", direction: "TRANSFER" }),
      ).toContain("direction");
    });

    it("rejects a timestamp that is not the one sortable format", async () => {
      for (const bad of [
        "2026-03-12 10:05:00",
        "2026-03-12T10:05Z",
        "2026-03-12T10:05:00+05:45",
        "12Mar26 10:05:00",
      ]) {
        expect(await fieldsRejected({ ...VALID, occurred_at: bad })).toEqual([
          "occurred_at",
        ]);
      }
    });

    it("rejects a date that does not exist", async () => {
      expect(
        await fieldsRejected({ ...VALID, occurred_at: "2026-02-31T10:05:00Z" }),
      ).toEqual(["occurred_at"]);
    });

    it("normalizes blank merchant and reference to null", async () => {
      const result = await validateTxnEvent({
        ...VALID,
        merchant: "   ",
        reference: "",
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.event.merchant).toBeNull();
      expect(result.event.reference).toBeNull();
    });

    it("reports every problem at once rather than the first", async () => {
      const errors = await fieldsRejected({
        bank: "OTHER",
        direction: "SIDEWAYS",
        amount_paisa: 12.5,
        reported_balance_paisa: "606055",
        occurred_at: "yesterday",
      });

      expect(errors).toEqual([
        "bank",
        "direction",
        "amount_paisa",
        "reported_balance_paisa",
        "occurred_at",
        "account_id",
      ]);
    });
  });
});
