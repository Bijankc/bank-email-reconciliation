import { SELF, env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { checkBearer } from "../src/auth";
import { handleQueueBatch } from "../src/consumer";
import type { TxnEvent } from "../src/types";
import {
  AUTH_HEADER,
  OPERATOR_HEADER,
  makeQueueBatch,
  makeQueuedMessage,
} from "./helpers";

/**
 * The dashboard read surface, driven through the real consumer so the rows it
 * reads were written by the real projection rather than by fixture SQL.
 *
 * Every account number, reference and merchant below is invented.
 */

const ACCOUNT = "NIMB:099XX7788";
const GAPPED = "NIMB:099XX7799";

function event(
  id: string,
  account: string,
  occurredAt: string,
  amountPaisa: number,
  balancePaisa: number,
): TxnEvent {
  return {
    event_id: `NIMB:${id}`,
    event_id_method: "reference",
    account_id: account,
    account_label: account.slice(5),
    bank: "NIMB",
    direction: "DEBIT",
    amount_paisa: amountPaisa,
    reported_balance_paisa: balancePaisa,
    occurred_at: occurredAt,
    merchant: "invented merchant",
    reference: id,
    source_channel: "email",
    schema_version: 1,
  };
}

/** Push events through the consumer: audit to R2, ledger, then projection. */
async function ingest(...events: TxnEvent[]): Promise<void> {
  for (const item of events) {
    const { batch } = makeQueueBatch([makeQueuedMessage({}, item)]);
    await handleQueueBatch(batch, env);
  }
}

const A1 = event("a1", ACCOUNT, "2026-03-12T09:00:00Z", 100000, 900000);
const A2 = event("a2", ACCOUNT, "2026-03-12T10:00:00Z", 5000, 895000);
const G1 = event("g1", GAPPED, "2026-03-12T09:00:00Z", 100000, 900000);
const G3 = event("g3", GAPPED, "2026-03-12T11:00:00Z", 2500, 892500);

beforeAll(async () => {
  await ingest(A1, A2, A2, G1, G3);
});

describe("GET /api/accounts", () => {
  it("lists the projected accounts", async () => {
    const response = await SELF.fetch("https://example.com/api/accounts");
    const body = await response.json<{
      source: string;
      accounts: { account_id: string; reconciliation_status: string }[];
    }>();

    expect(response.status).toBe(200);
    expect(body.source).toBe("projection");

    const account = body.accounts.find((row) => row.account_id === ACCOUNT);
    expect(account?.reconciliation_status).toBe("RECONCILED");

    const gapped = body.accounts.find((row) => row.account_id === GAPPED);
    expect(gapped?.reconciliation_status).toBe("PENDING_REVIEW");
  });
});

describe("GET /api/accounts/:id", () => {
  it("returns the summary, the marked timeline and the gaps", async () => {
    const response = await SELF.fetch(
      `https://example.com/api/accounts/${encodeURIComponent(ACCOUNT)}`,
    );
    const body = await response.json<{
      source: string;
      projection_version: number;
      account: { current_balance_paisa: number };
      timeline: { event_id: string; chains: boolean | null; delivery_count: number }[];
      gaps: unknown[];
    }>();

    expect(response.status).toBe(200);
    expect(body.source).toBe("projection");
    expect(body.account.current_balance_paisa).toBe(895000);
    expect(body.timeline.map((entry) => entry.event_id)).toEqual([
      "NIMB:a1",
      "NIMB:a2",
    ]);
    // The first event is an anchor; the second chains from it.
    expect(body.timeline[0].chains).toBeNull();
    expect(body.timeline[1].chains).toBe(true);
    expect(body.gaps).toHaveLength(0);
  });

  it("shows the duplicate delivery on the timeline row", async () => {
    // A2 was delivered twice. One row, two deliveries, balance unchanged.
    const response = await SELF.fetch(
      `https://example.com/api/accounts/${encodeURIComponent(ACCOUNT)}`,
    );
    const body = await response.json<{
      timeline: { event_id: string; delivery_count: number }[];
    }>();

    const row = body.timeline.find((entry) => entry.event_id === "NIMB:a2");
    expect(row?.delivery_count).toBe(2);
    expect(body.timeline).toHaveLength(2);
  });

  it("marks the gapped adjacency and points it at the gap", async () => {
    const response = await SELF.fetch(
      `https://example.com/api/accounts/${encodeURIComponent(GAPPED)}`,
    );
    const body = await response.json<{
      timeline: { chains: boolean | null; delta_paisa: number | null; gap_id: string | null }[];
      gaps: { gap_id: string; delta_paisa: number; status: string }[];
    }>();

    expect(body.timeline[1].chains).toBe(false);
    expect(body.timeline[1].delta_paisa).toBe(-5000);
    expect(body.gaps).toHaveLength(1);
    expect(body.gaps[0].delta_paisa).toBe(-5000);
    expect(body.gaps[0].status).toBe("PENDING_GAP");
    // The projected timeline can say which gap a failing adjacency belongs to,
    // which is what the dashboard draws between the two rows.
    expect(body.timeline[1].gap_id).toBe(body.gaps[0].gap_id);
  });

  it("404s an account that has never been seen", async () => {
    const response = await SELF.fetch(
      "https://example.com/api/accounts/NIMB%3Anot-an-account",
    );

    expect(response.status).toBe(404);
  });

  it("accepts the account id unencoded as well", async () => {
    // A colon is legal in a path segment, and a human typing the URL will not
    // encode it.
    const response = await SELF.fetch(`https://example.com/api/accounts/${ACCOUNT}`);

    expect(response.status).toBe(200);
  });
});

describe("GET /api/accounts/:id?authoritative=true", () => {
  it("reads the ledger directly", async () => {
    const response = await SELF.fetch(
      `https://example.com/api/accounts/${encodeURIComponent(ACCOUNT)}?authoritative=true`,
    );
    const body = await response.json<{
      source: string;
      version: number;
      current_balance_paisa: number;
      timeline: { event_id: string }[];
    }>();

    expect(body.source).toBe("authoritative");
    expect(body.current_balance_paisa).toBe(895000);
    expect(body.timeline.map((entry) => entry.event_id)).toEqual([
      "NIMB:a1",
      "NIMB:a2",
    ]);
  });

  it("makes replication lag visible when the projection is behind", async () => {
    // Apply straight to the ledger, skipping the consumer, which is exactly
    // what a message still sitting on the queue looks like from outside.
    const lagging = "NIMB:099XX7711";
    await ingest(event("l1", lagging, "2026-03-12T09:00:00Z", 100000, 900000));

    const stub = env.ACCOUNT_LEDGER.get(env.ACCOUNT_LEDGER.idFromName(lagging));
    await stub.apply(event("l2", lagging, "2026-03-12T10:00:00Z", 5000, 895000));

    const projected = await (
      await SELF.fetch(`https://example.com/api/accounts/${encodeURIComponent(lagging)}`)
    ).json<{ account: { current_balance_paisa: number; projection_version: number } }>();
    const authoritative = await (
      await SELF.fetch(
        `https://example.com/api/accounts/${encodeURIComponent(lagging)}?authoritative=true`,
      )
    ).json<{ current_balance_paisa: number; version: number }>();

    // Both are correct answers to different questions: one is what has been
    // replicated, the other is what is true.
    expect(projected.account.current_balance_paisa).toBe(900000);
    expect(authoritative.current_balance_paisa).toBe(895000);
    expect(authoritative.version).toBeGreaterThan(
      projected.account.projection_version,
    );
  });

  it("404s an account the ledger has never seen", async () => {
    const response = await SELF.fetch(
      "https://example.com/api/accounts/NIMB%3Aempty-ledger?authoritative=true",
    );

    expect(response.status).toBe(404);
  });
});

describe("GET /api/accounts/:id/audit", () => {
  it("lists the raw artifacts held for the account", async () => {
    const response = await SELF.fetch(
      `https://example.com/api/accounts/${encodeURIComponent(ACCOUNT)}/audit`,
    );
    const body = await response.json<{
      prefix: string;
      objects: { key: string; event_id: string; size: number }[];
    }>();

    expect(response.status).toBe(200);
    expect(body.prefix).toBe(`raw/${ACCOUNT}/`);
    expect(body.objects.map((object) => object.event_id).sort()).toEqual([
      "NIMB:a1",
      "NIMB:a2",
    ]);
    expect(body.objects[0].key.startsWith(`raw/${ACCOUNT}/`)).toBe(true);
  });

  it("lists keys and metadata but never a body", async () => {
    // The bodies are raw bank emails and this endpoint is unauthenticated.
    const response = await SELF.fetch(
      `https://example.com/api/accounts/${encodeURIComponent(ACCOUNT)}/audit`,
    );
    const text = await response.text();

    expect(text).not.toContain("Invented fixture body");
  });

  it("returns an empty listing for an unknown account", async () => {
    const response = await SELF.fetch(
      "https://example.com/api/accounts/NIMB%3Anothing/audit",
    );
    const body = await response.json<{ objects: unknown[] }>();

    expect(response.status).toBe(200);
    expect(body.objects).toHaveLength(0);
  });
});

describe("routing", () => {
  it("404s an unknown api path", async () => {
    const response = await SELF.fetch("https://example.com/api/accounts/x/y/z");
    expect(response.status).toBe(404);
  });

  it("does not accept POST on a read endpoint", async () => {
    const response = await SELF.fetch("https://example.com/api/accounts", {
      method: "POST",
    });
    expect(response.status).toBe(404);
  });
});

describe("POST /api/accounts/:id/gaps/:gapId/accept", () => {
  const REANCHOR = "NIMB:099XX7755";

  async function openConfirmedGap(): Promise<string> {
    await ingest(
      event("r1", REANCHOR, "2026-03-12T09:00:00Z", 100000, 900000),
      event("r3", REANCHOR, "2026-03-12T11:00:00Z", 2500, 892500),
    );
    const stub = env.ACCOUNT_LEDGER.get(env.ACCOUNT_LEDGER.idFromName(REANCHOR));
    const state = await stub.forceWindow();
    return state.gaps[0].gap_id;
  }

  it("rejects an unauthenticated accept", async () => {
    const response = await SELF.fetch(
      `https://example.com/api/accounts/${encodeURIComponent(REANCHOR)}/gaps/x/accept`,
      { method: "POST", body: JSON.stringify({ reason: "no token" }) },
    );

    expect(response.status).toBe(401);
  });

  it("requires a reason", async () => {
    // A gap accepted without one is indistinguishable later from a gap accepted
    // by accident.
    const response = await SELF.fetch(
      `https://example.com/api/accounts/${encodeURIComponent(REANCHOR)}/gaps/x/accept`,
      {
        method: "POST",
        headers: { ...OPERATOR_HEADER, "content-type": "application/json" },
        body: JSON.stringify({ reason: "   " }),
      },
    );

    expect(response.status).toBe(422);
  });

  it("accepts a confirmed gap and projects the result immediately", async () => {
    const gapId = await openConfirmedGap();

    const response = await SELF.fetch(
      `https://example.com/api/accounts/${encodeURIComponent(REANCHOR)}/gaps/${gapId}/accept`,
      {
        method: "POST",
        headers: { ...OPERATOR_HEADER, "content-type": "application/json" },
        body: JSON.stringify({ reason: "statement checked by hand" }),
      },
    );
    const body = await response.json<{
      accepted: boolean;
      reconciliation_status: string;
      projected: boolean;
    }>();

    expect(response.status).toBe(200);
    expect(body.accepted).toBe(true);
    expect(body.reconciliation_status).toBe("RECONCILED");
    // The change arrived over HTTP, not on the queue, so nothing else would
    // carry it to the read model.
    expect(body.projected).toBe(true);

    const projected = await (
      await SELF.fetch(`https://example.com/api/accounts/${encodeURIComponent(REANCHOR)}`)
    ).json<{
      account: { reconciliation_status: string; open_gap_count: number };
      gaps: { status: string; accept_reason: string }[];
    }>();

    expect(projected.account.reconciliation_status).toBe("RECONCILED");
    expect(projected.account.open_gap_count).toBe(0);
    // Recorded, not erased.
    expect(projected.gaps[0].status).toBe("ACCEPTED_GAP");
    expect(projected.gaps[0].accept_reason).toBe("statement checked by hand");
  });

  it("409s a gap that is still pending", async () => {
    const pendingAccount = "NIMB:099XX7766";
    await ingest(
      event("q1", pendingAccount, "2026-03-12T09:00:00Z", 100000, 900000),
      event("q3", pendingAccount, "2026-03-12T11:00:00Z", 2500, 892500),
    );
    const detail = await (
      await SELF.fetch(
        `https://example.com/api/accounts/${encodeURIComponent(pendingAccount)}`,
      )
    ).json<{ gaps: { gap_id: string }[] }>();

    const response = await SELF.fetch(
      `https://example.com/api/accounts/${encodeURIComponent(pendingAccount)}/gaps/${detail.gaps[0].gap_id}/accept`,
      {
        method: "POST",
        headers: { ...OPERATOR_HEADER, "content-type": "application/json" },
        body: JSON.stringify({ reason: "too soon" }),
      },
    );

    // 409, not 404: the gap exists, just not in a state that can be accepted.
    expect(response.status).toBe(409);
  });
});

describe("the two secrets are not interchangeable", () => {
  // The point of splitting them: one leak must not be both "inject fabricated
  // transactions" and "accept away a real discrepancy".

  it("refuses the simulator token on the gap accept route", async () => {
    const response = await SELF.fetch(
      `https://example.com/api/accounts/${encodeURIComponent(ACCOUNT)}/gaps/x/accept`,
      {
        method: "POST",
        headers: { ...AUTH_HEADER, "content-type": "application/json" },
        body: JSON.stringify({ reason: "wrong secret for this route" }),
      },
    );

    expect(response.status).toBe(401);
  });

  it("refuses the operator token on /webhook", async () => {
    const response = await SELF.fetch("https://example.com/webhook", {
      method: "POST",
      headers: { ...OPERATOR_HEADER, "content-type": "application/json" },
      body: JSON.stringify({ account_id: "NIMB:DEMO-X", bank: "NIMB" }),
    });

    expect(response.status).toBe(401);
  });

  it("refuses the operator token on force-window", async () => {
    const response = await SELF.fetch(
      `https://example.com/api/accounts/${encodeURIComponent(ACCOUNT)}/force-window`,
      { method: "POST", headers: OPERATOR_HEADER },
    );

    expect(response.status).toBe(401);
  });

  it("names the missing secret when one is unconfigured", async () => {
    // With two secrets, "not configured" on its own sends you looking at the
    // wrong one.
    const result = await checkBearer(
      new Request("https://example.com/", {
        headers: { authorization: "Bearer anything" },
      }),
      undefined,
      "OPERATOR_TOKEN",
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(503);
    expect(result.reason).toContain("OPERATOR_TOKEN");
  });
});

describe("POST /api/accounts/:id/force-window", () => {
  it("404s an account the ledger has never seen", async () => {
    // A Durable Object exists as soon as it is named, so a typo reaches a real
    // but empty ledger. Projecting that wrote a null bank and failed the D1
    // schema, which came back as a 500.
    const response = await SELF.fetch(
      "https://example.com/api/accounts/NIMB%3Anever-seen/force-window",
      { method: "POST", headers: AUTH_HEADER },
    );

    expect(response.status).toBe(404);
  });

  it("promotes a pending gap on an account that exists", async () => {
    const account = "NIMB:099XX7744";
    await ingest(
      event("w1", account, "2026-03-12T09:00:00Z", 100000, 900000),
      event("w3", account, "2026-03-12T11:00:00Z", 2500, 892500),
    );

    const response = await SELF.fetch(
      `https://example.com/api/accounts/${encodeURIComponent(account)}/force-window`,
      { method: "POST", headers: AUTH_HEADER },
    );
    const body = await response.json<{ reconciliation_status: string; projected: boolean }>();

    expect(response.status).toBe(200);
    expect(body.reconciliation_status).toBe("GAP_CONFIRMED");
    expect(body.projected).toBe(true);
  });
});
