/**
 * Test helpers. Everything produced here is invented: no value in this file or
 * in samples/redacted/ corresponds to a real account, merchant, or transaction.
 */

/**
 * Build a synthetic ForwardableEmailMessage so the email() handler can be
 * tested without Email Routing, a domain, or a Cloudflare account.
 */
export function makeEmailMessage(options: {
  from: string;
  to: string;
  raw: string;
}): ForwardableEmailMessage {
  const bytes = new TextEncoder().encode(options.raw);

  // Header parsing is deliberately minimal: just enough of the RFC 5322 block
  // for the handler under test. postal-mime does the real parsing in Phase 1.
  const headers = new Headers();
  for (const line of options.raw.split(/\r?\n/)) {
    if (line.trim() === "") break;
    const colon = line.indexOf(":");
    if (colon > 0) headers.set(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
  }

  return {
    from: options.from,
    to: options.to,
    headers,
    raw: new ReadableStream<Uint8Array>({
      start(controller) {
        // Deliberately split across two chunks so the reader cannot get away
        // with assuming the whole message arrives in one read.
        const midpoint = Math.floor(bytes.length / 2);
        controller.enqueue(bytes.slice(0, midpoint));
        controller.enqueue(bytes.slice(midpoint));
        controller.close();
      },
    }),
    rawSize: bytes.length,
    setReject: () => {},
    forward: async () => {},
    reply: async () => {},
  } as unknown as ForwardableEmailMessage;
}

export const AUTH_HEADER = {
  authorization: "Bearer test-token-not-a-real-secret",
};
