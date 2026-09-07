import type { Bank, Direction, EventIdMethod } from "../types";

/**
 * Idempotency key derivation (spec 5.4).
 *
 * No party in this pipeline issues an id: the bank does not put one in the
 * email, and Email Routing does not give a stable delivery id across a re-send.
 * The id therefore has to be a pure function of the message content, so that the
 * same transaction forwarded twice derives the same key both times and the
 * ledger's PRIMARY KEY catches the duplicate.
 */

export interface EventIdInput {
  bank: Bank;
  account_id: string;
  occurred_at: string;
  direction: Direction;
  amount_paisa: number;
  reference: string | null;
}

export interface DerivedEventId {
  event_id: string;
  event_id_method: EventIdMethod;
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function deriveEventId(input: EventIdInput): Promise<DerivedEventId> {
  const reference = input.reference?.trim();
  if (reference !== undefined && reference !== "") {
    return {
      event_id: `${input.bank}:${reference}`,
      event_id_method: "reference",
    };
  }

  // Fields are joined with a separator the bank data cannot contain. Bare
  // concatenation would let a different field split produce the same string,
  // which is a dedup collision between two genuinely different transactions.
  const material = [
    input.bank,
    input.account_id,
    input.occurred_at,
    input.direction,
    String(input.amount_paisa),
  ].join("\u0000");

  return {
    event_id: `${input.bank}:${await sha256Hex(material)}`,
    event_id_method: "hash",
  };
}
