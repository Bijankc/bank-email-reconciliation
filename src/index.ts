import {
  acceptGap,
  getAccount,
  getAuthoritativeAccount,
  listAccounts,
  listAudit,
} from "./api";
import { checkBearer } from "./auth";
import { handleQueueBatch } from "./consumer";
import { handleEmail } from "./ingress/email";
import { enqueueEvent } from "./ingress/enqueue";
import { SCHEMA_VERSION, type QueuedTxnMessage } from "./types";
import { validateTxnEvent } from "./validate";

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
  let ledgerSchemaVersion: number | null = null;
  await record("durable_object", async () => {
    const stub = env.ACCOUNT_LEDGER.get(env.ACCOUNT_LEDGER.idFromName("__health__"));
    // The DO schema version is reported separately from the event schema
    // version: they move independently, and a Durable Object that failed to
    // migrate is otherwise invisible until the first transaction hits it.
    const status = await stub.status();
    ledgerSchemaVersion = status.ledger_schema_version;
    return status;
  });
  // A queue producer has no read side, so presence of the binding is all that
  // can be checked without emitting a message the consumer would have to eat.
  await record("queue_producer", async () => {
    if (typeof env.TXN_QUEUE?.send !== "function") throw new Error("TXN_QUEUE not bound");
  });

  checks["simulator_token"] = env.SIMULATOR_TOKEN ? "configured" : "unset";

  return json(
    {
      ok: healthy,
      schema_version: SCHEMA_VERSION,
      ledger_schema_version: ledgerSchemaVersion,
      checks,
    },
    healthy ? 200 : 503,
  );
}

/**
 * Simulator ingress (spec 5.5). A real external event source, injected into
 * over HTTP behind a bearer secret - not an internal test hook - so it goes
 * through the same validation, the same queue and the same ledger as a bank
 * email. The only thing it skips is the parsers, because it arrives already
 * normalized.
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

  const validated = await validateTxnEvent(body);
  if (!validated.ok) {
    // 422, not 400: the JSON parsed, the content is wrong. Every field error is
    // returned at once so a hand-edited event can be fixed in one pass.
    return json({ error: "event failed validation", errors: validated.errors }, 422);
  }

  const event = validated.event;
  // The archived artifact for a simulator event is the validated event itself,
  // serialized. There is no upstream payload to keep, and storing the raw body
  // instead would archive whatever unvalidated extras the caller sent.
  const enqueued = await enqueueEvent(env, event, JSON.stringify(event, null, 2), "json");

  console.log(
    JSON.stringify({
      at: "webhook.queued",
      event_id: event.event_id,
      account_id: event.account_id,
      event_id_method: event.event_id_method,
    }),
  );

  // 202: the event is durably queued, not yet reconciled. Reconciliation is async.
  return json(
    {
      accepted: true,
      event_id: enqueued.event_id,
      account_id: event.account_id,
      event_id_method: event.event_id_method,
    },
    202,
  );
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    // Split once and match on the parts. Every id in this system is namespaced
    // with a colon, which is legal in a path segment but routinely encoded by
    // clients, so each segment is decoded rather than compared raw.
    const path = url.pathname.split("/").filter((part) => part !== "");
    const segment = (index: number) => decodeURIComponent(path[index] ?? "");

    if (request.method === "GET" && url.pathname === "/health") {
      return health(env);
    }
    if (request.method === "POST" && url.pathname === "/webhook") {
      return webhook(request, env);
    }

    if (request.method === "GET" && path[0] === "api" && path[1] === "accounts") {
      if (path.length === 2) {
        return json(await listAccounts(env));
      }

      const accountId = segment(2);

      if (path.length === 3) {
        // The teaching toggle: the same account, read from the eventually
        // consistent projection or from the authoritative ledger.
        const body =
          url.searchParams.get("authoritative") === "true"
            ? await getAuthoritativeAccount(env, accountId)
            : await getAccount(env, accountId);

        return body === null
          ? json({ error: "no such account", account_id: accountId }, 404)
          : json(body);
      }

      if (path.length === 4 && path[3] === "audit") {
        return json(await listAudit(env, accountId));
      }
    }

    // POST /api/accounts/:id/gaps/:gapId/accept
    if (
      request.method === "POST" &&
      path.length === 6 &&
      path[0] === "api" &&
      path[1] === "accounts" &&
      path[3] === "gaps" &&
      path[5] === "accept"
    ) {
      // Bearer-authenticated like /webhook: this one writes, and it writes the
      // fact that a human accepted a discrepancy.
      const auth = await checkBearer(request, env.SIMULATOR_TOKEN);
      if (!auth.ok) return json({ error: auth.reason }, auth.status);

      let body: { reason?: unknown } = {};
      try {
        body = (await request.json()) as { reason?: unknown };
      } catch {
        return json({ error: "body must be valid JSON" }, 400);
      }

      const result = await acceptGap(
        env,
        segment(2),
        segment(4),
        typeof body.reason === "string" ? body.reason : null,
      );
      return json(result.body, result.status);
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
