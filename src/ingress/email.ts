import { parseBankEmail } from "../parse";
import type { Bank, TxnEvent } from "../types";
import { enqueueEvent } from "./enqueue";

/**
 * Real ingress: Cloudflare Email Routing delivers a forwarded bank alert here.
 *
 * The handler stays on the fast path - read, parse, enqueue - because a slow
 * email() handler stalls delivery. Reconciliation happens asynchronously in the
 * queue consumer.
 */

export interface ReceivedEmail {
  from: string;
  to: string;
  /** Bytes of the full MIME message, as received. This is the R2 audit artifact. */
  raw: string;
  size: number;
  subject: string | null;
  message_id: string | null;
}

/** What happened to one delivered message. Returned rather than only logged so
 *  the handler can be asserted on without scraping console output. */
export type EmailIngressResult =
  | { ok: true; event: TxnEvent; queued: true; raw_truncated: boolean }
  | { ok: false; bank: Bank | null; field: string; message: string };

/** Drain the raw MIME stream into a string without assuming a chunk boundary. */
export async function readRawEmail(
  stream: ReadableStream<Uint8Array>,
): Promise<string> {
  const chunks: Uint8Array[] = [];
  let total = 0;

  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.length;
    }
  } finally {
    reader.releaseLock();
  }

  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder().decode(joined);
}

export async function receiveEmail(
  message: ForwardableEmailMessage,
): Promise<ReceivedEmail> {
  const raw = await readRawEmail(message.raw);
  return {
    from: message.from,
    to: message.to,
    raw,
    size: raw.length,
    subject: message.headers.get("subject"),
    message_id: message.headers.get("message-id"),
  };
}

export async function handleEmail(
  message: ForwardableEmailMessage,
  env: Env,
): Promise<EmailIngressResult> {
  const received = await receiveEmail(message);

  // Deliberately does not log `raw`: it carries the full account number and
  // balance history, and Workers logs are not the right home for them.
  console.log(
    JSON.stringify({
      at: "email.received",
      from: received.from,
      to: received.to,
      subject: received.subject,
      size: received.size,
    }),
  );

  const outcome = await parseBankEmail(received.raw);

  if (!outcome.ok) {
    // Permanent, not transient. Email Routing accepted this message from the
    // sender before the handler ran, so there is nobody left to bounce it to
    // and nothing a retry would change: the same body fails identically every
    // time. It is recorded and dropped rather than put on the queue, where it
    // would burn five attempts on its way to the dead-letter queue.
    console.warn(
      JSON.stringify({
        at: "email.parse_failed",
        from: received.from,
        bank: outcome.bank,
        field: outcome.field,
        message: outcome.message,
      }),
    );
    return outcome;
  }

  const enqueued = await enqueueEvent(env, outcome.event, received.raw, "eml");

  // A summary, not the event: amount and balance were logged in full during
  // Phase 1 so the parse could be inspected, but they do not belong in a
  // persistent log now that the ledger is where they are meant to live.
  console.log(
    JSON.stringify({
      at: "email.queued",
      event_id: enqueued.event_id,
      account_id: outcome.event.account_id,
      bank: outcome.event.bank,
      direction: outcome.event.direction,
      event_id_method: outcome.event.event_id_method,
      raw_bytes: enqueued.raw_bytes,
    }),
  );

  return {
    ok: true,
    event: outcome.event,
    queued: true,
    raw_truncated: enqueued.raw_truncated,
  };
}
