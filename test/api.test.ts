import { SELF, env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { handleQueueBatch } from "../src/consumer";
import type { TxnEvent } from "../src/types";
import { makeQueueBatch, makeQueuedMessage } from "./helpers";

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
