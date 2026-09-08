import type { QueuedTxnMessage, TxnEvent } from "../src/types";

/**
 * Test helpers. Everything produced here is invented: no value in this file or
 * in samples/redacted/ corresponds to a real account, merchant, or transaction.
 */

/**
 * Build a synthetic ForwardableEmailMessage so the email() handler can be
 * tested without Email Routing, a domain, or a Cloudflare account.
 */
export function makeEmailMessage(options: {
  from: string;
  to: string;
  raw: string;
}): ForwardableEmailMessage {
  const bytes = new TextEncoder().encode(options.raw);

  // Header parsing is deliberately minimal: just enough of the RFC 5322 block
  // for the handler under test. postal-mime does the real parsing in Phase 1.
  const headers = new Headers();
  for (const line of options.raw.split(/\r?\n/)) {
    if (line.trim() === "") break;
    const colon = line.indexOf(":");
    if (colon > 0) headers.set(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
  }

  return {
    from: options.from,
    to: options.to,
    headers,
    raw: new ReadableStream<Uint8Array>({
      start(controller) {
        // Deliberately split across two chunks so the reader cannot get away
        // with assuming the whole message arrives in one read.
        const midpoint = Math.floor(bytes.length / 2);
        controller.enqueue(bytes.slice(0, midpoint));
        controller.enqueue(bytes.slice(midpoint));
        controller.close();
      },
    }),
    rawSize: bytes.length,
    setReject: () => {},
    forward: async () => {},
    reply: async () => {},
  } as unknown as ForwardableEmailMessage;
}

export const AUTH_HEADER = {
  authorization: "Bearer test-token-not-a-real-secret",
};

/** One queue message plus the ack/retry calls the consumer made on it. */
export interface FakeQueueMessage {
  message: Message<QueuedTxnMessage>;
  acked: () => number;
  retried: () => number;
}

/**
 * Build a MessageBatch the consumer can be run against directly. The queue
 * itself is proven end to end under `wrangler dev`; this exists to assert the
 * ack-versus-retry decision, which a real queue only reveals by redelivering.
 */
export function makeQueueBatch(
  bodies: QueuedTxnMessage[],
  options: { attempts?: number } = {},
): { batch: MessageBatch<QueuedTxnMessage>; calls: FakeQueueMessage[] } {
  const calls: FakeQueueMessage[] = [];

  const messages = bodies.map((body, index) => {
    let acks = 0;
    let retries = 0;
    const message = {
      id: `msg-${index}`,
      timestamp: new Date("2026-03-12T00:00:00Z"),
      attempts: options.attempts ?? 1,
      body,
      ack: () => {
        acks += 1;
      },
      retry: () => {
        retries += 1;
      },
    } as unknown as Message<QueuedTxnMessage>;

    calls.push({ message, acked: () => acks, retried: () => retries });
    return message;
  });

  return {
    batch: { queue: "txn-events", messages, ackAll: () => {}, retryAll: () => {} } as unknown as MessageBatch<QueuedTxnMessage>,
    calls,
  };
}

/** A complete, valid queue message. Every value in it is invented. */
export function makeQueuedMessage(
  overrides: Partial<QueuedTxnMessage> = {},
  eventOverrides: Partial<TxnEvent> = {},
): QueuedTxnMessage {
  return {
    event: {
      event_id: "NIMB:88213047qLmT",
      event_id_method: "reference",
      account_id: "NIMB:099XX4417",
      account_label: "099XX4417",
      bank: "NIMB",
      direction: "DEBIT",
      amount_paisa: 145000,
      reported_balance_paisa: 731055,
      occurred_at: "2026-03-12T09:14:22Z",
      merchant: "coffee",
      reference: "88213047qLmT",
      source_channel: "email",
      schema_version: 1,
      ...eventOverrides,
    },
    raw: ["From: donot_reply@nimb.com.np", "", "Invented fixture body."].join("\r\n"),
    raw_format: "eml",
    raw_truncated: false,
    received_at: "2026-03-12T09:14:30Z",
    ...overrides,
  };
}
