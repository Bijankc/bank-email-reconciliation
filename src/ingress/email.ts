import { parseBankEmail, type ParseOutcome } from "../parse";

/**
 * Real ingress: Cloudflare Email Routing delivers a forwarded bank alert here.
 *
 * The handler stays on the fast path - read, parse, enqueue - because a slow
 * email() handler stalls delivery. Reconciliation happens asynchronously in the
 * queue consumer.
 *
 * Phase 1 reads and parses; the enqueue lands in Phase 2.
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
): Promise<ParseOutcome> {
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

  // Phase 1 logs the normalized event in full so the parse can be inspected in
  // `wrangler dev`. Phase 2 enqueues it and drops this back to a summary line -
  // the balance does not belong in a persistent log once it is no longer the
  // thing being verified.
  console.log(JSON.stringify({ at: "email.parsed", event: outcome.event }));

  return outcome;
}
