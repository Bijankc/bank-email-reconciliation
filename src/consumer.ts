import { writeAudit } from "./audit";
import { projectAccount, projectTransaction } from "./projection";
import type { QueuedTxnMessage } from "./types";

/**
 * Queue consumer. Delivery is at-least-once, so every step here must be safe to
 * repeat: the R2 key is derived from the event and written once, and the ledger
 * dedups on the event_id primary key.
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

      // The ledger is reached only after the artifact is durable, so a failure
      // between the two retries against evidence that is already stored.
      const stub = env.ACCOUNT_LEDGER.get(
        env.ACCOUNT_LEDGER.idFromName(event.account_id),
      );
      const applied = await stub.apply(event);

      console.log(
        JSON.stringify({
          at: "ledger.applied",
          message_id: message.id,
          event_id: event.event_id,
          account_id: event.account_id,
          outcome: applied.outcome,
          delivery_count: applied.delivery_count,
          version: applied.state.version,
          reconciliation_status: applied.state.reconciliation_status,
          event_count: applied.state.event_count,
          open_gap_count: applied.state.open_gap_count,
        }),
      );

      // The read model. The account row goes first: both transactions and gaps
      // carry a foreign key to it, so on the first event for an account there
      // is nothing to attach to until it exists.
      const projected = await projectAccount(env, applied.state);

      // Written even when the account projection was superseded. A superseded
      // write means a newer version already wrote the account row, so the
      // foreign key holds; and this row is per-event history rather than
      // versioned state, so skipping it would drop a transaction from the
      // timeline permanently. This is also the only place that knows which R2
      // object holds the raw bytes.
      await projectTransaction(env, event, {
        outcome: applied.outcome,
        delivery_count: applied.delivery_count,
        raw_r2_key: audit.key,
        received_at: message.body.received_at,
      });

      if (!projected.applied) {
        // Not an error. Another delivery for this account got there first with
        // a newer version, and this write was correctly discarded.
        console.log(
          JSON.stringify({
            at: "projection.superseded",
            event_id: event.event_id,
            account_id: event.account_id,
            version: projected.version,
            stored_version: projected.storedVersion,
          }),
        );
      }

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
