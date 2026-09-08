import { describe, expect, it } from "vitest";
import nabilCreditFixture from "../samples/redacted/nabil-credit.eml?raw";
import nabilFixture from "../samples/redacted/nabil-debit.eml?raw";
import nimbMultipartFixture from "../samples/redacted/nimb-credit-multipart.eml?raw";
import nimbNoRefFixture from "../samples/redacted/nimb-no-reference.eml?raw";
import nimbFixture from "../samples/redacted/nimb-debit.eml?raw";
import { detectBank, extractParts, parseBankEmail } from "../src/parse";
import { deriveEventId } from "../src/parse/event-id";
import { formatPaisa, parsePaisa } from "../src/parse/money";
import { parseNabilHtml } from "../src/parse/nabil";
import { parseNimbText } from "../src/parse/nimb";
import { parseNabilTimestamp, parseNimbTimestamp } from "../src/parse/time";

// Every account number, merchant, balance and reference asserted in this file is
// invented. See samples/redacted/README.md.

describe("parsePaisa", () => {
  it("converts the formats both banks print", () => {
    expect(parsePaisa("1,450.00")).toBe(145000);
    expect(parsePaisa("7,310.55")).toBe(731055);
    expect(parsePaisa("310.55")).toBe(31055);
    expect(parsePaisa("0.05")).toBe(5);
    expect(parsePaisa("NPR 2,500.00")).toBe(250000);
  });

  it("reads a one-digit decimal as tenths of a rupee, not paisa", () => {
    // "5" after the point is 50 paisa. Padding left instead of right would land
    // a 4,500.50 credit as 4,500.05.
    expect(parsePaisa("1.5")).toBe(150);
  });

  it("handles lakh-style grouping", () => {
    expect(parsePaisa("1,00,000.00")).toBe(10000000);
  });

  it("is exact where float arithmetic is not", () => {
    // parseFloat("7310.55") * 100 === 731054.9999999999. One paisa out is a
    // phantom gap, so this is the assertion the money type exists for.
    expect(parsePaisa("7,310.55")).toBe(731055);
    expect(parsePaisa("2,538.46")).toBe(253846);
    expect(parsePaisa("3,018.36")).toBe(301836);
  });

  it("rejects anything that is not a bank amount", () => {
    expect(() => parsePaisa("")).toThrow();
    expect(() => parsePaisa("abc")).toThrow();
    expect(() => parsePaisa("1.234")).toThrow();
    expect(() => parsePaisa("-50.00")).toThrow();
  });

  it("round-trips through formatPaisa", () => {
    expect(formatPaisa(731055)).toBe("7310.55");
    expect(formatPaisa(5)).toBe("0.05");
    expect(parsePaisa(formatPaisa(253846))).toBe(253846);
  });
});

describe("timestamps", () => {
  it("normalizes the jammed DDMonYY form NIMB uses", () => {
    expect(parseNimbTimestamp("12Mar26 09:14:22")).toBe("2026-03-12T03:29:22Z");
    expect(parseNimbTimestamp("28Aug26 14:38:20")).toBe("2026-08-28T08:53:20Z");
  });

  it("normalizes the seconds-less form Nabil uses to :00", () => {
    expect(parseNabilTimestamp("2026-03-12 10:05")).toBe("2026-03-12T04:20:00Z");
    expect(parseNabilTimestamp("2026-08-28 14:20")).toBe("2026-08-28T08:35:00Z");
  });

  it("converts Nepal local time to a true UTC instant", async () => {
    // The offset is the point of the conversion, so it gets its own assertion
    // rather than riding along inside a larger toEqual. 05:45, no DST.
    const npt = Date.parse("2026-03-12T09:14:22Z");
    const utc = Date.parse(parseNimbTimestamp("12Mar26 09:14:22"));

    expect(npt - utc).toBe((5 * 60 + 45) * 60 * 1000);
  });

  it("puts both banks on the same time base", async () => {
    // The same wall-clock reading from either bank has to become the same
    // instant, or two accounts could never be compared against each other.
    expect(parseNimbTimestamp("12Mar26 10:05:00")).toBe(
      parseNabilTimestamp("2026-03-12 10:05"),
    );
  });

  it("carries the conversion back across midnight", async () => {
    // 02:00 NPT is the previous day in UTC. A naive implementation that only
    // subtracted from the clock fields would give 2026-03-12T20:15:00Z.
    expect(parseNimbTimestamp("12Mar26 02:00:00")).toBe("2026-03-11T20:15:00Z");
  });

  it("refuses a date that does not exist instead of rolling it over", () => {
    // Date.UTC turns 31 Feb into 3 March. Silently accepting that puts the event
    // in the wrong place in the chain, which is worse than failing the parse.
    expect(() => parseNimbTimestamp("31Feb26 09:00:00")).toThrow();
    expect(() => parseNabilTimestamp("2026-02-31 09:00")).toThrow();
  });

  it("refuses a malformed stamp", () => {
    expect(() => parseNimbTimestamp("12Mar26 09:14")).toThrow();
    expect(() => parseNimbTimestamp("12Foo26 09:14:22")).toThrow();
    expect(() => parseNabilTimestamp("12/03/2026 10:05")).toThrow();
  });
});

describe("event_id derivation", () => {
  const base = {
    bank: "NIMB",
    account_id: "NIMB:099XX4417",
    occurred_at: "2026-03-12T09:14:22Z",
    direction: "DEBIT",
    amount_paisa: 145000,
  } as const;

  it("namespaces the bank reference when there is one", async () => {
    const derived = await deriveEventId({ ...base, reference: "88213047qLmT" });

    expect(derived.event_id).toBe("NIMB:88213047qLmT");
    expect(derived.event_id_method).toBe("reference");
  });

  it("falls back to a hash of the stable fields", async () => {
    const derived = await deriveEventId({ ...base, reference: null });

    expect(derived.event_id_method).toBe("hash");
    expect(derived.event_id).toMatch(/^NIMB:[0-9a-f]{64}$/);
  });

  it("derives the same id twice for the same transaction", async () => {
    // The whole idempotency story: a re-forwarded email has no id of its own, so
    // the key has to be a pure function of what the email says.
    const first = await deriveEventId({ ...base, reference: null });
    const second = await deriveEventId({ ...base, reference: null });

    expect(first.event_id).toBe(second.event_id);
  });

  it("derives a different id when any stable field differs", async () => {
    const original = await deriveEventId({ ...base, reference: null });

    for (const variant of [
      { ...base, amount_paisa: 145001, reference: null },
      { ...base, direction: "CREDIT" as const, reference: null },
      { ...base, occurred_at: "2026-03-12T09:14:23Z", reference: null },
      { ...base, account_id: "NIMB:099XX4418", reference: null },
    ]) {
      const derived = await deriveEventId(variant);
      expect(derived.event_id).not.toBe(original.event_id);
    }
  });

  it("treats a blank reference as no reference", async () => {
    const derived = await deriveEventId({ ...base, reference: "   " });
    expect(derived.event_id_method).toBe("hash");
  });
});

describe("NIMB text parser", () => {
  it("reads the movement, the balance and the detail blob", async () => {
    const parts = await extractParts(nimbFixture);
    const fields = parseNimbText(parts.text ?? "");

    expect(fields).toEqual({
      account_label: "099XX4417",
      direction: "DEBIT",
      amount_paisa: 145000,
      reported_balance_paisa: 731055,
      // The debit time (09:14:22 NPT), not the balance-read time (09:15:01),
      // converted to UTC: 09:14:22 - 05:45 = 03:29:22.
      occurred_at: "2026-03-12T03:29:22Z",
      merchant: "coffee",
      reference: "88213047qLmT",
    });
  });

  it("reads a credit", async () => {
    const parts = await extractParts(nimbMultipartFixture);
    const fields = parseNimbText(parts.text ?? "");

    expect(fields.direction).toBe("CREDIT");
    expect(fields.amount_paisa).toBe(250000);
    expect(fields.reported_balance_paisa).toBe(981055);
  });

  it("survives a missing detail line with null reference and merchant", async () => {
    const parts = await extractParts(nimbNoRefFixture);
    const fields = parseNimbText(parts.text ?? "");

    expect(fields.reference).toBeNull();
    expect(fields.merchant).toBeNull();
    expect(fields.amount_paisa).toBe(31055);
  });

  it("refuses a message with no Available Balance line", () => {
    // Without a reported balance there is nothing to reconcile against, so this
    // is a hard failure rather than a null column.
    expect(() =>
      parseNimbText("Your a/c 099XX4417 has been Debited by NPR 10.00 on 12Mar26 09:14:22."),
    ).toThrow(/reported_balance_paisa/);
  });

  it("refuses a message with no movement sentence", () => {
    expect(() => parseNimbText("Available Balance on 12Mar26 09:15:01 is NPR 7,310.55")).toThrow(
      /movement/,
    );
  });
});

describe("Nabil HTML parser", () => {
  it("reads the transaction row out of the table", async () => {
    const parts = await extractParts(nabilFixture);
    const fields = await parseNabilHtml(parts.html ?? "");

    expect(fields).toEqual({
      account_label: "220XXXXXX881904",
      direction: "DEBIT",
      amount_paisa: 125000,
      reported_balance_paisa: 606055,
      occurred_at: "2026-03-12T04:20:00Z",
      merchant: "ORCHID STATIONERS PVT. LTD. KTM",
      reference: "71104582WxYz",
    });
  });

  it("sees through wrapper spans, a tbody and an HTML entity", async () => {
    const parts = await extractParts(nabilCreditFixture);
    const fields = await parseNabilHtml(parts.html ?? "");

    expect(fields.direction).toBe("CREDIT");
    expect(fields.amount_paisa).toBe(400000);
    expect(fields.reported_balance_paisa).toBe(1006055);
    expect(fields.reference).toBe("88350021ZmPq");
    // The merchant itself contains a comma, so the remarks blob cannot be read
    // as exactly three tokens.
    expect(fields.merchant).toBe("DEEPAK & SONS TRADERS, LALITPUR");
  });

  it("finds the columns by header text, not by position", async () => {
    // Same data, columns reordered and one inserted. A positional parser reads
    // the balance out of the Channel column here.
    const reordered = `<html><body><p>account 220XXXXXX881904</p><table>
      <tr><th>Channel</th><th>Remarks</th><th>Transaction Type</th>
          <th>Available Balance</th><th>Transaction Amount</th><th>Transaction Date</th></tr>
      <tr><td>MOBILE</td><td>MPAY FPQR,71104582WxYz,ORCHID STATIONERS PVT. LTD. KTM</td>
          <td>Debit</td><td>6,060.55</td><td>1,250.00</td><td>2026-03-12 10:05</td></tr>
    </table></body></html>`;

    const fields = await parseNabilHtml(reordered);

    expect(fields.amount_paisa).toBe(125000);
    expect(fields.reported_balance_paisa).toBe(606055);
    expect(fields.reference).toBe("71104582WxYz");
  });

  it("refuses HTML with no transaction table", async () => {
    await expect(
      parseNabilHtml("<html><body><p>account 220XXXXXX881904</p></body></html>"),
    ).rejects.toThrow(/table/);
  });

  it("refuses a table whose header is present but whose body is empty", async () => {
    const headerOnly = `<html><body><p>account 220XXXXXX881904</p><table>
      <tr><th>Transaction Date</th><th>Transaction Type</th><th>Transaction Amount</th>
          <th>Available Balance</th><th>Remarks</th></tr>
    </table></body></html>`;

    await expect(parseNabilHtml(headerOnly)).rejects.toThrow(/data row/);
  });
});

describe("detectBank", () => {
  it("routes on the sender domain", async () => {
    expect(detectBank(await extractParts(nimbFixture))).toBe("NIMB");
    expect(detectBank(await extractParts(nabilFixture))).toBe("NABIL");
  });

  it("falls back to the body shape when a forward rewrote the sender", async () => {
    const parts = await extractParts(nimbFixture);
    expect(detectBank({ ...parts, from: "someone@gmail.com" })).toBe("NIMB");
  });

  it("returns null for a message from neither bank", () => {
    expect(
      detectBank({ from: "newsletter@example.invalid", subject: "Hello", text: "Hi", html: null }),
    ).toBeNull();
  });
});

describe("parseBankEmail", () => {
  it("normalizes a NIMB alert into the event contract", async () => {
    const outcome = await parseBankEmail(nimbFixture);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.event).toEqual({
      event_id: "NIMB:88213047qLmT",
      event_id_method: "reference",
      account_id: "NIMB:099XX4417",
      account_label: "099XX4417",
      bank: "NIMB",
      direction: "DEBIT",
      amount_paisa: 145000,
      reported_balance_paisa: 731055,
      occurred_at: "2026-03-12T03:29:22Z",
      merchant: "coffee",
      reference: "88213047qLmT",
      source_channel: "email",
      schema_version: 1,
    });
  });

  it("normalizes a Nabil alert into the same shape", async () => {
    const outcome = await parseBankEmail(nabilFixture);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.event).toEqual({
      event_id: "NABIL:71104582WxYz",
      event_id_method: "reference",
      account_id: "NABIL:220XXXXXX881904",
      account_label: "220XXXXXX881904",
      bank: "NABIL",
      direction: "DEBIT",
      amount_paisa: 125000,
      reported_balance_paisa: 606055,
      occurred_at: "2026-03-12T04:20:00Z",
      merchant: "ORCHID STATIONERS PVT. LTD. KTM",
      reference: "71104582WxYz",
      source_channel: "email",
      schema_version: 1,
    });
  });

  it("gives both banks an identical key set", async () => {
    // Nothing downstream can tell the two apart except by reading `bank`.
    const nimb = await parseBankEmail(nimbFixture);
    const nabil = await parseBankEmail(nabilFixture);

    expect(nimb.ok && nabil.ok).toBe(true);
    if (!nimb.ok || !nabil.ok) return;
    expect(Object.keys(nimb.event).sort()).toEqual(Object.keys(nabil.event).sort());
  });

  it("picks the text part out of a multipart NIMB alert", async () => {
    const outcome = await parseBankEmail(nimbMultipartFixture);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.event.direction).toBe("CREDIT");
    expect(outcome.event.event_id).toBe("NIMB:90417755rTgH");
    expect(outcome.event.merchant).toBe("salary");
  });

  it("marks a reference-less event as hash-derived", async () => {
    const outcome = await parseBankEmail(nimbNoRefFixture);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.event.event_id_method).toBe("hash");
    expect(outcome.event.event_id).toMatch(/^NIMB:[0-9a-f]{64}$/);
    expect(outcome.event.reference).toBeNull();
  });

  it("derives the same event_id from a re-forwarded copy of one email", async () => {
    // The duplicate Phase 3 has to catch. A Gmail re-forward rewrites headers,
    // so only the body is stable - which is why the id comes from the body and
    // not from Message-ID.
    const first = await parseBankEmail(nimbFixture);
    const reforwarded = nimbFixture.replace(
      "<redacted-nimb-0001@example.invalid>",
      "<some-other-id@example.invalid>",
    );
    const second = await parseBankEmail(reforwarded);

    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.event.event_id).toBe(first.event.event_id);
  });

  it("reports an unrecognised sender as a parse outcome, not an exception", async () => {
    const outcome = await parseBankEmail(
      "From: newsletter@example.invalid\r\nSubject: Sale\r\n\r\nHalf price today.",
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.field).toBe("bank");
  });

  it("reports a recognised sender whose body will not parse", async () => {
    const outcome = await parseBankEmail(
      "From: donot_reply@nimb.com.np\r\nSubject: Statement\r\n\r\nYour a/c 099XX4417 has been Debited by NPR 10.00 on 12Mar26 09:14:22.",
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.bank).toBe("NIMB");
    expect(outcome.field).toBe("reported_balance_paisa");
  });
});
