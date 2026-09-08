import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { AUTH_HEADER } from "./helpers";

const sampleEvent = {
  event_id: "NABIL:71104582WxYz",
  account_id: "NABIL:220XXXXXX881904",
  bank: "NABIL",
  direction: "DEBIT",
  amount_paisa: 125000,
  reported_balance_paisa: 606055,
  occurred_at: "2026-03-12T10:05:00Z",
  merchant: "ORCHID STATIONERS PVT. LTD.",
  reference: "71104582WxYz",
  source_channel: "simulator",
  schema_version: 1,
  event_id_method: "reference",
};

describe("GET /health", () => {
  it("reports every binding reachable", async () => {
    const response = await SELF.fetch("https://example.com/health");
    const body = await response.json<{
      ok: boolean;
      checks: Record<string, string>;
    }>();

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.checks.d1).toBe("ok");
    expect(body.checks.r2).toBe("ok");
    expect(body.checks.durable_object).toBe("ok");
    expect(body.checks.queue_producer).toBe("ok");
    expect(body.checks.simulator_token).toBe("configured");
  });
});

describe("POST /webhook", () => {
  it("rejects a request with no bearer token", async () => {
    const response = await SELF.fetch("https://example.com/webhook", {
      method: "POST",
      body: JSON.stringify(sampleEvent),
    });

    expect(response.status).toBe(401);
  });

  it("rejects a wrong bearer token", async () => {
    const response = await SELF.fetch("https://example.com/webhook", {
      method: "POST",
      headers: { authorization: "Bearer definitely-not-the-token" },
      body: JSON.stringify(sampleEvent),
    });

    expect(response.status).toBe(401);
  });

  it("rejects a token that is a prefix of the real one", async () => {
    // Guards the constant-time comparison against a naive startsWith/slice bug.
    const response = await SELF.fetch("https://example.com/webhook", {
      method: "POST",
      headers: { authorization: "Bearer test-token" },
      body: JSON.stringify(sampleEvent),
    });

    expect(response.status).toBe(401);
  });

  it("rejects a malformed body", async () => {
    const response = await SELF.fetch("https://example.com/webhook", {
      method: "POST",
      headers: AUTH_HEADER,
      body: "{ not json",
    });

    expect(response.status).toBe(400);
  });

  it("rejects an event with no account_id", async () => {
    const { account_id: _omitted, ...withoutAccount } = sampleEvent;
    const response = await SELF.fetch("https://example.com/webhook", {
      method: "POST",
      headers: AUTH_HEADER,
      body: JSON.stringify(withoutAccount),
    });

    expect(response.status).toBe(422);
  });

  it("accepts an authenticated event and enqueues it", async () => {
    const response = await SELF.fetch("https://example.com/webhook", {
      method: "POST",
      headers: AUTH_HEADER,
      body: JSON.stringify(sampleEvent),
    });

    // 202, not 200: the event is durably queued, not yet reconciled.
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({
      accepted: true,
      event_id: "NABIL:71104582WxYz",
      account_id: "NABIL:220XXXXXX881904",
      event_id_method: "reference",
    });
  });

  it("derives the event_id when the caller omits it", async () => {
    const { event_id: _omitted, reference: _also, ...withoutId } = sampleEvent;

    const response = await SELF.fetch("https://example.com/webhook", {
      method: "POST",
      headers: AUTH_HEADER,
      body: JSON.stringify(withoutId),
    });
    const body = await response.json<{ event_id: string; event_id_method: string }>();

    expect(response.status).toBe(202);
    expect(body.event_id).toMatch(/^NABIL:[0-9a-f]{64}$/);
    expect(body.event_id_method).toBe("hash");
  });

  it("returns every field error at once for a bad event", async () => {
    const response = await SELF.fetch("https://example.com/webhook", {
      method: "POST",
      headers: AUTH_HEADER,
      body: JSON.stringify({ ...sampleEvent, amount_paisa: 1250.5, direction: "SIDEWAYS" }),
    });
    const body = await response.json<{ errors: { field: string }[] }>();

    // 422, not 400: the JSON parsed, the content is wrong.
    expect(response.status).toBe(422);
    expect(body.errors.map((error) => error.field)).toEqual([
      "direction",
      "amount_paisa",
    ]);
  });

  it("refuses rupees where paisa are expected", async () => {
    // The unit pin, enforced at the boundary rather than assumed downstream.
    const response = await SELF.fetch("https://example.com/webhook", {
      method: "POST",
      headers: AUTH_HEADER,
      body: JSON.stringify({ ...sampleEvent, amount_paisa: 1250.55 }),
    });

    expect(response.status).toBe(422);
  });
});

describe("routing", () => {
  it("404s an unknown path", async () => {
    const response = await SELF.fetch("https://example.com/nope");
    expect(response.status).toBe(404);
  });

  it("does not accept GET on /webhook", async () => {
    const response = await SELF.fetch("https://example.com/webhook");
    expect(response.status).toBe(404);
  });
});

describe("D1 read model", () => {
  it("has the projection schema from migrations/0001_init.sql", async () => {
    const tables = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    ).all<{ name: string }>();
    const names = tables.results.map((row) => row.name);

    expect(names).toContain("accounts");
    expect(names).toContain("transactions");
    expect(names).toContain("gaps");
  });

  it("refuses a negative projection_version", async () => {
    // The version guard depends on this constraint holding.
    await expect(
      env.DB.prepare(
        "INSERT INTO accounts (account_id, bank, projection_version, created_at) VALUES ('NABIL:bad', 'NABIL', -1, '2026-03-12T00:00:00Z')",
      ).run(),
    ).rejects.toThrow();
  });

  it("refuses an unknown bank", async () => {
    await expect(
      env.DB.prepare(
        "INSERT INTO accounts (account_id, bank, created_at) VALUES ('OTHER:1', 'OTHER', '2026-03-12T00:00:00Z')",
      ).run(),
    ).rejects.toThrow();
  });
});
