import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { auditKey, keySegment, writeAudit } from "../src/audit";
import { handleDeadLetterBatch, handleQueueBatch } from "../src/consumer";
import { POISON_REFERENCE } from "../src/types";
import { makeQueueBatch, makeQueuedMessage } from "./helpers";

/**
 * The audit write and the ack-versus-retry decision. Both are properties a real
 * queue only demonstrates by redelivering, so they are asserted directly here;
 * the queue itself is exercised end to end under `wrangler dev`.
 */

describe("auditKey", () => {
  it("lays out the key the spec asks for", async () => {
    expect(auditKey("NIMB:099XX4417", "NIMB:88213047qLmT", "eml")).toBe(
      "raw/NIMB:099XX4417/NIMB:88213047qLmT.eml",
    );
  });

  it("uses .json for simulator events", async () => {
    expect(auditKey("NABIL:220XXXXXX881904", "NABIL:71104582WxYz", "json")).toBe(
      "raw/NABIL:220XXXXXX881904/NABIL:71104582WxYz.json",
    );
  });

  it("escapes a slash so a reference cannot nest the object", async () => {
    // A bank reference containing a slash would otherwise create a directory
    // level and put the object somewhere the account prefix does not reach.
    expect(auditKey("NIMB:099XX4417", "NIMB:a/b", "eml")).toBe(
      "raw/NIMB:099XX4417/NIMB:a%2Fb.eml",
    );
  });

  it("keeps the escape reversible", async () => {
    expect(decodeURIComponent(keySegment("100%/y"))).toBe("100%/y");
  });
});

describe("writeAudit", () => {
  it("stores the raw payload verbatim under the derived key", async () => {
    const message = makeQueuedMessage({}, { event_id: "NIMB:audit-1" });

    const result = await writeAudit(env, message);

    expect(result.written).toBe(true);
    expect(result.key).toBe("raw/NIMB:099XX4417/NIMB:audit-1.eml");

    const stored = await env.AUDIT.get(result.key);
    expect(stored).not.toBeNull();
    await expect(stored?.text()).resolves.toBe(message.raw);
    expect(stored?.customMetadata?.event_id).toBe("NIMB:audit-1");
    expect(stored?.customMetadata?.source_channel).toBe("email");
    expect(stored?.httpMetadata?.contentType).toBe("message/rfc822");
  });

  it("keeps the first bytes when the same event arrives again", async () => {
    // A re-forwarded email carries the same derived event_id but different
    // bytes: a new Message-ID and extra Received headers. The original artifact
    // is the one worth having, so the second write is skipped, not applied.
    const first = makeQueuedMessage(
      { raw: "Message-ID: <original@example.invalid>" },
      { event_id: "NIMB:audit-2" },
    );
    const reforward = makeQueuedMessage(
      { raw: "Message-ID: <gmail-reforward@example.invalid>" },
      { event_id: "NIMB:audit-2" },
    );

    const a = await writeAudit(env, first);
    const b = await writeAudit(env, reforward);

    expect(a.written).toBe(true);
    expect(b.written).toBe(false);
    expect(b.key).toBe(a.key);

    const stored = await env.AUDIT.get(a.key);
    await expect(stored?.text()).resolves.toBe(
      "Message-ID: <original@example.invalid>",
    );
  });

  it("marks a truncated artifact in object metadata", async () => {
    const message = makeQueuedMessage(
      { raw_truncated: true },
      { event_id: "NIMB:audit-3" },
    );

    const result = await writeAudit(env, message);
    const stored = await env.AUDIT.head(result.key);

    expect(stored?.customMetadata?.truncated).toBe("true");
  });
});

describe("handleQueueBatch", () => {
  it("audits then acks a delivered event", async () => {
    const { batch, calls } = makeQueueBatch([
      makeQueuedMessage({}, { event_id: "NIMB:queue-1" }),
    ]);

    await handleQueueBatch(batch, env);

    expect(calls[0].acked()).toBe(1);
    expect(calls[0].retried()).toBe(0);
    expect(await env.AUDIT.head("raw/NIMB:099XX4417/NIMB:queue-1.eml")).not.toBeNull();
  });

  it("processes every message in a batch", async () => {
    const { batch, calls } = makeQueueBatch([
      makeQueuedMessage({}, { event_id: "NIMB:queue-2" }),
      makeQueuedMessage({}, { event_id: "NIMB:queue-3" }),
    ]);

    await handleQueueBatch(batch, env);

    expect(calls.map((call) => call.acked())).toEqual([1, 1]);
  });

  it("retries a transient storage failure instead of acking it", async () => {
    // The event must survive an R2 hiccup. Acking here would lose it silently;
    // retrying hands it back to the queue for backoff and, eventually, the DLQ.
    const failing = {
      AUDIT: {
        head: async () => null,
        put: async () => {
          throw new Error("R2 unavailable");
        },
      },
    } as unknown as Env;

    const { batch, calls } = makeQueueBatch([
      makeQueuedMessage({}, { event_id: "NIMB:queue-4" }),
    ]);

    await handleQueueBatch(batch, failing);

    expect(calls[0].retried()).toBe(1);
    expect(calls[0].acked()).toBe(0);
  });

  it("acks a message it can never process rather than retrying forever", async () => {
    // No event_id means nothing to key an audit object on and nothing to
    // reconcile. Every redelivery would fail identically.
    const { batch, calls } = makeQueueBatch([
      { event: {}, raw: "", raw_format: "json", raw_truncated: false, received_at: "" },
    ] as never);

    await handleQueueBatch(batch, env);

    expect(calls[0].acked()).toBe(1);
    expect(calls[0].retried()).toBe(0);
  });

  it("does not overwrite the audit object on redelivery", async () => {
    // At-least-once: the same message can arrive twice. The second pass must be
    // a no-op against the store, not a rewrite.
    const message = makeQueuedMessage({}, { event_id: "NIMB:queue-5" });
    const first = makeQueueBatch([message]);
    const second = makeQueueBatch([message], { attempts: 2 });

    await handleQueueBatch(first.batch, env);
    const afterFirst = await env.AUDIT.head("raw/NIMB:099XX4417/NIMB:queue-5.eml");
    await handleQueueBatch(second.batch, env);
    const afterSecond = await env.AUDIT.head("raw/NIMB:099XX4417/NIMB:queue-5.eml");

    expect(second.calls[0].acked()).toBe(1);
    expect(afterSecond?.uploaded.getTime()).toBe(afterFirst?.uploaded.getTime());
  });
});

describe("the poison hook and the dead-letter queue", () => {
  it("fails a poison event every time instead of applying it", async () => {
    // The demo needs a message that reliably exhausts its retries. It throws
    // after the audit write and before the ledger, so nothing reaches an
    // account and the raw payload is still archived.
    const { batch, calls } = makeQueueBatch([
      makeQueuedMessage({}, { event_id: "NIMB:poison-1", reference: POISON_REFERENCE }),
    ]);

    await handleQueueBatch(batch, env);

    expect(calls[0].retried()).toBe(1);
    expect(calls[0].acked()).toBe(0);
  });

  it("still archives the poison payload before failing", async () => {
    const { batch } = makeQueueBatch([
      makeQueuedMessage({}, { event_id: "NIMB:poison-2", reference: POISON_REFERENCE }),
    ]);

    await handleQueueBatch(batch, env);

    // Audit-first is what makes a poisoned event investigable rather than lost.
    expect(
      await env.AUDIT.head("raw/NIMB:099XX4417/NIMB:poison-2.eml"),
    ).not.toBeNull();
  });

  it("never lets a poison event reach the ledger", async () => {
    const { batch } = makeQueueBatch([
      makeQueuedMessage(
        {},
        {
          event_id: "NIMB:poison-3",
          account_id: "NIMB:poison-account",
          reference: POISON_REFERENCE,
        },
      ),
    ]);

    await handleQueueBatch(batch, env);

    const stub = env.ACCOUNT_LEDGER.get(
      env.ACCOUNT_LEDGER.idFromName("NIMB:poison-account"),
    );
    expect((await stub.status()).event_count).toBe(0);
  });

  it("does not block the messages behind it in the batch", async () => {
    // The whole point of a dead-letter queue: one bad message must not stop
    // the pipeline.
    const { batch, calls } = makeQueueBatch([
      makeQueuedMessage({}, { event_id: "NIMB:poison-4", reference: POISON_REFERENCE }),
      makeQueuedMessage({}, { event_id: "NIMB:healthy-after-poison" }),
    ]);

    await handleQueueBatch(batch, env);

    expect(calls[0].retried()).toBe(1);
    expect(calls[1].acked()).toBe(1);
  });

  it("acks whatever reaches the dead-letter queue rather than retrying it", async () => {
    // A message here has already failed every attempt on the main queue.
    // Retrying it would repeat that failure forever.
    const { batch, calls } = makeQueueBatch(
      [makeQueuedMessage({}, { event_id: "NIMB:poison-5", reference: POISON_REFERENCE })],
      { attempts: 6 },
    );

    await handleDeadLetterBatch(batch, env);

    expect(calls[0].acked()).toBe(1);
    expect(calls[0].retried()).toBe(0);
  });

  it("leaves the ledger untouched from the dead-letter path too", async () => {
    const { batch } = makeQueueBatch([
      makeQueuedMessage({}, { event_id: "NIMB:poison-6", account_id: "NIMB:dlq-account" }),
    ]);

    await handleDeadLetterBatch(batch, env);

    const stub = env.ACCOUNT_LEDGER.get(
      env.ACCOUNT_LEDGER.idFromName("NIMB:dlq-account"),
    );
    expect((await stub.status()).event_count).toBe(0);
  });
});
