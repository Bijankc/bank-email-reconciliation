import { checkBearer } from "./auth";
import { handleQueueBatch } from "./consumer";
import { handleEmail } from "./ingress/email";
import { SCHEMA_VERSION, type QueuedTxnMessage } from "./types";

export { AccountLedger } from "./account-ledger";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/**
 * Binding smoke check. Touches every binding for real rather than asserting the
 * config parsed, so a misconfigured D1 or R2 surfaces here instead of three
 * phases later.
 */
async function health(env: Env): Promise<Response> {
  const checks: Record<string, string> = {};
  let healthy = true;

  const record = async (name: string, probe: () => Promise<unknown>) => {
    try {
      await probe();
      checks[name] = "ok";
    } catch (error) {
      healthy = false;
      checks[name] = `error: ${error instanceof Error ? error.message : String(error)}`;
    }
  };

  await record("d1", () => env.DB.prepare("SELECT COUNT(*) AS n FROM accounts").first());
  await record("r2", () => env.AUDIT.list({ limit: 1 }));
  await record("durable_object", async () => {
    const stub = env.ACCOUNT_LEDGER.get(env.ACCOUNT_LEDGER.idFromName("__health__"));
    return stub.status();
  });
  // A queue producer has no read side, so presence of the binding is all that
  // can be checked without emitting a message the consumer would have to eat.
  await record("queue_producer", async () => {
    if (typeof env.TXN_QUEUE?.send !== "function") throw new Error("TXN_QUEUE not bound");
  });

  checks["simulator_token"] = env.SIMULATOR_TOKEN ? "configured" : "unset";

  return json(
    { ok: healthy, schema_version: SCHEMA_VERSION, checks },
    healthy ? 200 : 503,
  );
}

/**
 * Simulator ingress. Phase 0 authenticates and enqueues so the async path is
 * provable locally without waiting on a real bank transaction; full field
 * validation arrives with the parsers in Phase 2.
 */
async function webhook(request: Request, env: Env): Promise<Response> {
  const auth = await checkBearer(request, env.SIMULATOR_TOKEN);
  if (!auth.ok) return json({ error: auth.reason }, auth.status);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "body must be valid JSON" }, 400);
  }

  const event = body as QueuedTxnMessage["event"];
  if (!event || typeof event !== "object" || !event.account_id || !event.event_id) {
    return json({ error: "event must carry account_id and event_id" }, 422);
  }

  const message: QueuedTxnMessage = {
    event: { ...event, source_channel: "simulator" },
    raw: JSON.stringify(body),
    raw_format: "json",
    received_at: new Date().toISOString(),
  };
  await env.TXN_QUEUE.send(message);

  // 202: the event is durably queued, not yet reconciled. Reconciliation is async.
  return json({ accepted: true, event_id: event.event_id }, 202);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return health(env);
    }
    if (request.method === "POST" && url.pathname === "/webhook") {
      return webhook(request, env);
    }
    return json({ error: "not found", path: url.pathname }, 404);
  },

  async email(message: ForwardableEmailMessage, env: Env): Promise<void> {
    await handleEmail(message, env);
  },

  async queue(batch: MessageBatch<QueuedTxnMessage>, env: Env): Promise<void> {
    await handleQueueBatch(batch, env);
  },
} satisfies ExportedHandler<Env, QueuedTxnMessage>;
