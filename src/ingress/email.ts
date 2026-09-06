import type { QueuedTxnMessage } from "../types";

/**
 * Real ingress: Cloudflare Email Routing delivers a forwarded bank alert here.
 *
 * The handler stays on the fast path - read, parse, enqueue - because a slow
 * email() handler stalls delivery. Reconciliation happens asynchronously in the
 * queue consumer.
 *
 * Phase 0 reads and characterises the message only; the NIMB and Nabil parsers
 * land in Phase 1 and the enqueue in Phase 2.
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
  _env: Env,
): Promise<void> {
  const received = await receiveEmail(message);

  // Deliberately does not log `raw`: it carries account numbers and balances,
  // and Workers logs are not the right home for them.
  console.log(
    JSON.stringify({
      at: "email.received",
      from: received.from,
      to: received.to,
      subject: received.subject,
      size: received.size,
    }),
  );

  // Phase 1 parses, Phase 2 enqueues a QueuedTxnMessage here.
  void (null as QueuedTxnMessage | null);
}
