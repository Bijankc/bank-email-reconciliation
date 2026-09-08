import type { QueuedTxnMessage } from "./types";

/**
 * The R2 audit log (spec 7.3).
 *
 * Key: raw/{account_id}/{event_id}.eml, or .json for simulator events. Both
 * components come from the event itself, so the key is derived rather than
 * allocated: no counter, no clock, no coordination. Two deliveries of the same
 * transaction compute the same key, which is what lets an at-least-once queue
 * and a write-once audit store coexist.
 *
 * This bucket holds unredacted bank mail. It is private and stays private; see
 * the note on r2_buckets in wrangler.jsonc.
 */

const CONTENT_TYPE = {
  eml: "message/rfc822",
  json: "application/json; charset=utf-8",
} as const;

/**
 * Escape the two characters that would change a key path into something else.
 * A forward slash inside a bank reference would silently nest the object one
 * level deeper, so it is escaped; percent is escaped first so the mapping stays
 * reversible. Everything else, including the colon in NIMB:099XX4417, is left
 * alone because a browsable audit bucket is worth more than a uniform encoding.
 */
export function keySegment(value: string): string {
  return value.replace(/%/g, "%25").replace(/\//g, "%2F");
}

export function auditKey(
  accountId: string,
  eventId: string,
  format: QueuedTxnMessage["raw_format"],
): string {
  return `raw/${keySegment(accountId)}/${keySegment(eventId)}.${format}`;
}

export interface AuditResult {
  key: string;
  /** False when the object was already there and the existing bytes were kept. */
  written: boolean;
  size: number;
}

/**
 * Archive the raw payload before anything else touches the event.
 *
 * Write-once is enforced by checking first and skipping rather than by
 * overwriting with identical bytes. The spec assumes a retry rewrites the same
 * key with the same bytes, and for a queue retry that is true; for a re-forward
 * it is not. The same transaction forwarded twice from Gmail carries the same
 * derived event_id but different bytes - a new Message-ID, extra Received
 * headers, possibly a different transfer encoding. Overwriting would let the
 * later copy replace the original artifact in an audit store whose whole value
 * is being the first thing that arrived.
 *
 * The check-then-write race (two deliveries in flight at once) can only cost a
 * duplicate write of bytes for one event_id, which is harmless. Losing the
 * original is not.
 *
 * Failures are not caught here. An R2 hiccup is transient, and the caller turns
 * a throw into a queue retry with backoff (spec 9).
 */
export async function writeAudit(
  env: Env,
  message: QueuedTxnMessage,
): Promise<AuditResult> {
  const { event, raw, raw_format } = message;
  const key = auditKey(event.account_id, event.event_id, raw_format);
  const size = new TextEncoder().encode(raw).length;

  const existing = await env.AUDIT.head(key);
  if (existing !== null) {
    return { key, written: false, size: existing.size };
  }

  await env.AUDIT.put(key, raw, {
    httpMetadata: { contentType: CONTENT_TYPE[raw_format] },
    // Enough to answer "what is this object and where did it come from" from
    // the bucket alone, without parsing the payload back out.
    customMetadata: {
      event_id: event.event_id,
      account_id: event.account_id,
      bank: event.bank,
      source_channel: event.source_channel,
      occurred_at: event.occurred_at,
      received_at: message.received_at,
      truncated: message.raw_truncated ? "true" : "false",
    },
  });

  return { key, written: true, size };
}
