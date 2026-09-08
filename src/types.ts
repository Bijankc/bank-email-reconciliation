/**
 * The normalized transaction event. Both bank parsers and the simulator produce
 * exactly this shape; nothing downstream of ingress knows which bank an event
 * came from except by reading `bank`.
 *
 * Money is integer paisa (rupees * 100) throughout. See docs/DECISIONS.md.
 */

export type Bank = "NIMB" | "NABIL";
export type Direction = "DEBIT" | "CREDIT";
export type SourceChannel = "email" | "simulator";

/** Which derivation produced `event_id`. A hash-derived id is the weaker of the two. */
export type EventIdMethod = "reference" | "hash";

export const SCHEMA_VERSION = 1 as const;

/**
 * The poison hook (spec 9). An event whose reference is exactly this value is
 * made to fail in the consumer, every time, so the retry-to-dead-letter path
 * can be demonstrated on demand.
 *
 * It is a reference rather than a source_channel because a source_channel is
 * part of the audit record and should describe where an event really came from.
 * A reference is data the bank supplies, and no bank issues this one.
 */
export const POISON_REFERENCE = "POISON-DLQ-DEMO";

export interface TxnEvent {
  /** Idempotency key. `{bank}:{reference}`, or a hash of stable fields. */
  event_id: string;
  /** The Durable Object key: bank + masked account number. */
  account_id: string;
  bank: Bank;
  direction: Direction;
  /** Integer paisa, always positive. Direction carries the sign. */
  amount_paisa: number;
  /** Available balance AFTER this transaction, integer paisa. */
  reported_balance_paisa: number;
  /** ISO-8601 UTC. The chain sorts on this, not on arrival order. */
  occurred_at: string;
  merchant: string | null;
  reference: string | null;
  source_channel: SourceChannel;
  schema_version: typeof SCHEMA_VERSION;
  /** Recorded because a hash-derived id cannot distinguish two identical
   *  transactions in the same second, and that weakness should be visible. */
  event_id_method: EventIdMethod;
  /** Masked account string as the bank printed it, for display. */
  account_label?: string | null;
}

/** What the consumer puts on the queue: the event plus the raw bytes to audit. */
export interface QueuedTxnMessage {
  event: TxnEvent;
  /** Verbatim payload as received, archived to R2 before the ledger is touched. */
  raw: string;
  /** "eml" for real email, "json" for simulator events. Picks the R2 key suffix. */
  raw_format: "eml" | "json";
  /**
   * True when `raw` was cut to fit the queue message limit. The transaction
   * facts are unaffected; only the archived artifact is incomplete, and it is
   * flagged here and in the R2 object metadata so the audit trail never claims
   * to be verbatim when it is not.
   */
  raw_truncated: boolean;
  received_at: string;
}
