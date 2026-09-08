import type { QueuedTxnMessage } from "./types";

/**
 * Queue consumer. Delivery is at-least-once, so every step here must be safe to
 * repeat: R2 writes are write-once to a derived key, and the ledger dedups on
 * event_id. Transient failures throw so the queue retries with backoff rather
 * than silently dropping an event.
 *
 * Phase 0 logs and acks. R2 audit lands in Phase 2, the DO call in Phase 3, the
 * D1 projection in Phase 4.
 */
export async function handleQueueBatch(
  batch: MessageBatch<QueuedTxnMessage>,
  env: Env,
): Promise<void> {
  for (const message of batch.messages) {
    try {
      console.log(
        JSON.stringify({
          at: "queue.received",
          queue: batch.queue,
          message_id: message.id,
          attempt: message.attempts,
          event_id: message.body?.event?.event_id ?? null,
          account_id: message.body?.event?.account_id ?? null,
          source: message.body?.event?.source_channel ?? null,
        }),
      );

      // Phase 0 binding proof: the ledger DO is reachable from the consumer.
      const accountId = message.body?.event?.account_id;
      if (accountId) {
        const stub = env.ACCOUNT_LEDGER.get(
          env.ACCOUNT_LEDGER.idFromName(accountId),
        );
        const status = await stub.status();
        console.log(
          JSON.stringify({ at: "queue.ledger_reached", account_id: accountId, status }),
        );
      }

      message.ack();
    } catch (error) {
      // Retry rather than ack: a transient D1/R2/DO failure must not consume the
      // event. After max_retries the queue routes it to the DLQ.
      console.error(
        JSON.stringify({
          at: "queue.failed",
          message_id: message.id,
          attempt: message.attempts,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      message.retry();
    }
  }
}
