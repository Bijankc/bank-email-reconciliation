import type { QueuedTxnMessage, TxnEvent } from "../types";

/**
 * The one way an event enters the pipeline. Both ingress paths - the email()
 * handler and POST /webhook - end here, so they cannot drift into producing
 * different queue messages for the same kind of transaction.
 *
 * Ingress stays on the fast path (spec 9): validate, enqueue, return. Nothing
 * here touches R2, D1 or the ledger. A slow email() handler stalls Email
 * Routing delivery, and a slow /webhook makes the simulator feel like the
 * engine is synchronous when the entire point is that it is not.
 */

/**
 * Queue messages are capped at 128 KB. The cap here is deliberately well under
 * that: the message carries the event alongside the raw payload, and hitting
 * the real limit would surface as an opaque send failure at ingress rather than
 * as something readable.
 */
export const MAX_QUEUED_RAW_BYTES = 96 * 1024;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface EnqueueResult {
  event_id: string;
  raw_bytes: number;
  raw_truncated: boolean;
}

/**
 * Cut to a byte budget rather than a character count, because the limit is on
 * bytes and a multi-byte character would otherwise let a "short enough" string
 * exceed it. A cut can land mid-character; the decoder replaces the remnant,
 * which is acceptable for an artifact already marked incomplete.
 */
function truncateToBytes(value: string, limit: number): string {
  const bytes = encoder.encode(value);
  if (bytes.length <= limit) return value;
  return decoder.decode(bytes.slice(0, limit));
}

export async function enqueueEvent(
  env: Env,
  event: TxnEvent,
  raw: string,
  rawFormat: QueuedTxnMessage["raw_format"],
): Promise<EnqueueResult> {
  const rawBytes = encoder.encode(raw).length;
  const truncated = rawBytes > MAX_QUEUED_RAW_BYTES;

  const message: QueuedTxnMessage = {
    event,
    raw: truncated ? truncateToBytes(raw, MAX_QUEUED_RAW_BYTES) : raw,
    raw_format: rawFormat,
    raw_truncated: truncated,
    received_at: new Date().toISOString(),
  };

  if (truncated) {
    // Loud, because an audit store that silently holds partial evidence is
    // worse than one that holds none. The transaction itself still reconciles:
    // every field the ledger needs is in `event`, not in `raw`.
    console.warn(
      JSON.stringify({
        at: "ingress.raw_truncated",
        event_id: event.event_id,
        raw_bytes: rawBytes,
        limit: MAX_QUEUED_RAW_BYTES,
      }),
    );
  }

  // Not wrapped in a try: a send failure is infrastructure, not bad input.
  // Swallowing it would drop the transaction silently; letting it throw fails
  // the invocation, which is the only signal either caller can still act on.
  await env.TXN_QUEUE.send(message);

  return {
    event_id: event.event_id,
    raw_bytes: rawBytes,
    raw_truncated: truncated,
  };
}
