import type { Direction } from "../types";

/**
 * What a bank parser is responsible for: the facts the email states, and
 * nothing derived. `event_id` and `account_id` are composed downstream so that
 * both parsers cannot drift on how a key is built.
 */
export interface ParsedFields {
  /** The masked account number exactly as the bank printed it. */
  account_label: string;
  direction: Direction;
  amount_paisa: number;
  /** Available balance AFTER the movement. The whole chain check rests on this. */
  reported_balance_paisa: number;
  occurred_at: string;
  merchant: string | null;
  reference: string | null;
}
