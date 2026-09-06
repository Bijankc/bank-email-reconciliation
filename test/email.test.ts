import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import nimbFixture from "../samples/redacted/nimb-debit.eml?raw";
import nabilFixture from "../samples/redacted/nabil-debit.eml?raw";
import { handleEmail, readRawEmail, receiveEmail } from "../src/ingress/email";
import { makeEmailMessage } from "./helpers";

// The email() path cannot be exercised through Email Routing without a domain
// and a Cloudflare account, so it is driven here by a synthetic
// ForwardableEmailMessage over a redacted fixture. Every value in those
// fixtures is invented.

describe("readRawEmail", () => {
  it("reassembles a message split across stream chunks", async () => {
    const message = makeEmailMessage({
      from: "donot_reply@nimb.com.np",
      to: "alerts@example.invalid",
      raw: nimbFixture,
    });

    const raw = await readRawEmail(message.raw);

    expect(raw).toBe(nimbFixture);
  });

  it("handles an empty stream without hanging", async () => {
    const empty = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      },
    });

    await expect(readRawEmail(empty)).resolves.toBe("");
  });
});

describe("receiveEmail", () => {
  it("characterises a NIMB plain-text alert", async () => {
    const message = makeEmailMessage({
      from: "donot_reply@nimb.com.np",
      to: "alerts@example.invalid",
      raw: nimbFixture,
    });

    const received = await receiveEmail(message);

    expect(received.from).toBe("donot_reply@nimb.com.np");
    expect(received.to).toBe("alerts@example.invalid");
    expect(received.subject).toBe("Transaction Alert");
    expect(received.size).toBe(nimbFixture.length);
    // The raw bytes are preserved verbatim: this string is the R2 audit artifact.
    expect(received.raw).toContain("Available Balance on 12Mar26 09:15:01 is NPR 7,310.55");
  });

  it("characterises a Nabil HTML alert", async () => {
    const message = makeEmailMessage({
      from: "txn-alert@nabilbank.com",
      to: "alerts@example.invalid",
      raw: nabilFixture,
    });

    const received = await receiveEmail(message);

    expect(received.from).toBe("txn-alert@nabilbank.com");
    expect(received.subject).toBe("Nabil Bank Transaction Alert");
    expect(received.raw).toContain("<td>2026-03-12 10:05</td>");
  });

  it("keeps the two banks' raw shapes genuinely different", async () => {
    // The point of the two parsers in Phase 1: same facts, unrelated encodings.
    expect(nimbFixture).toContain("has been Debited by NPR");
    expect(nimbFixture).not.toContain("<table");
    expect(nabilFixture).toContain("<table");
    expect(nabilFixture).not.toContain("has been Debited by NPR");
  });
});

describe("handleEmail", () => {
  it("consumes a forwarded alert without throwing", async () => {
    const message = makeEmailMessage({
      from: "donot_reply@nimb.com.np",
      to: "alerts@example.invalid",
      raw: nimbFixture,
    });

    await expect(handleEmail(message, env)).resolves.toBeUndefined();
  });
});
