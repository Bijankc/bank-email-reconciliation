import { ParseError } from "./errors";

/**
 * Money parsing. See docs/DECISIONS.md 0.1: every amount in this system is an
 * integer count of paisa, and no float is allowed to touch one.
 *
 * Both banks print money the same way - comma thousands separators and two
 * decimal places ("1,450.00", "7,310.55") - so one parser serves both.
 */

const AMOUNT = /^(\d{1,3}(?:,\d{2,3})*|\d+)(?:\.(\d{1,2}))?$/;

/**
 * "1,450.00" -> 145000.
 *
 * Deliberately does not go through parseFloat. `parseFloat("7310.55") * 100` is
 * 731054.9999999999, which floors to a balance one paisa short of what the bank
 * said - and a one-paisa error is a phantom gap in an engine whose entire job is
 * an equality test.
 */
export function parsePaisa(raw: string, field = "amount"): number {
  const cleaned = raw.trim().replace(/^NPR\s*/i, "").trim();
  const match = AMOUNT.exec(cleaned);
  if (match === null) {
    throw new ParseError(field, `not a bank-formatted amount: ${JSON.stringify(raw)}`);
  }

  const rupees = Number(match[1].replace(/,/g, ""));
  // "5" means 50 paisa, not 5. Pad right, not left.
  const paisa = Number((match[2] ?? "").padEnd(2, "0") || "0");

  const total = rupees * 100 + paisa;
  if (!Number.isSafeInteger(total)) {
    throw new ParseError(field, `amount exceeds safe integer range: ${cleaned}`);
  }
  return total;
}

/** 145000 -> "1450.00". For logs and API responses; never used in arithmetic. */
export function formatPaisa(paisa: number): string {
  const sign = paisa < 0 ? "-" : "";
  const absolute = Math.abs(paisa);
  return `${sign}${Math.trunc(absolute / 100)}.${String(absolute % 100).padStart(2, "0")}`;
}
