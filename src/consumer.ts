import { writeAudit } from "./audit";
import type { QueuedTxnMessage } from "./types";

/**
 * Queue consumer. Delivery is at-least-once, so every step here must be safe to
 * repeat: the R2 key is derived from the event and written once, and from
 * Phase 3 the ledger dedups on event_id.
 *
 * The failure split is the point of this file (spec 9):
 *
 *  - transient failure (R2 or, later, D1 and the DO) -> retry(). The queue
 *    re-delivers with backoff, and after max_retries the message lands in the
 *    dead-letter queue instead of blocking the pipeline.
 *  - malformed message -> ack(). A body that is missing an account_id fails
 *    identically on every attempt, so retrying it buys nothing and costs five
 *    deliveries.
 *
 * Audit before ledger, deliberately. If the archive write succeeds and a later
 * step fails, the retry re-runs against an artifact that is already stored. The
 * reverse order can reconcile a transaction whose evidence was never kept.
 */
export async function handleQueueBatch(
  batch: MessageBatch<QueuedTxnMessage>,
  env: Env,
): Promise<void> {
  for (const message of batch.messages) {
    const event = message.body?.event;

    console.log(
      JSON.stringify({
        at: "queue.received",
        queue: batch.queue,
        message_id: message.id,
        attempt: message.attempts,
        event_id: event?.event_id ?? null,
        account_id: event?.account_id ?? null,
        source: event?.source_channel ?? null,
      }),
    );

    if (!event?.event_id || !event.account_id) {
      // Nothing to key an audit object on and nothing to reconcile. Permanent.
      console.error(
        JSON.stringify({
          at: "queue.unusable",
          message_id: message.id,
          reason: "message body carries no event_id/account_id",
        }),
      );
      message.ack();
      continue;
    }

    try {
      const audit = await writeAudit(env, message.body);

      console.log(
        JSON.stringify({
          at: audit.written ? "audit.written" : "audit.exists",
          message_id: message.id,
          attempt: message.attempts,
          event_id: event.event_id,
          key: audit.key,
          bytes: audit.size,
          truncated: message.body.raw_truncated,
        }),
      );

      // Phase 3 calls the ledger DO here, with the audit object already durable.
      message.ack();
    } catch (error) {
      console.error(
        JSON.stringify({
          at: "queue.failed",
          message_id: message.id,
          attempt: message.attempts,
          event_id: event.event_id,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      message.retry();
    }
  }
}
