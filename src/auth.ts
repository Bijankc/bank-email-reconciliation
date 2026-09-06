/**
 * Bearer-token check for the write endpoints (/webhook, gap accept).
 *
 * Two properties matter here and both are deliberate:
 *  - Fail closed. If SIMULATOR_TOKEN is unset, every request is rejected. An
 *    unset secret must never mean "auth disabled" on a public deployment.
 *  - Constant time. Both sides are hashed to a fixed 32 bytes before comparison,
 *    so the comparison leaks neither the token's content nor its length.
 */

const encoder = new TextEncoder();

async function sha256(value: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest("SHA-256", encoder.encode(value));
}

export type AuthResult =
  | { ok: true }
  | { ok: false; status: 401 | 503; reason: string };

export async function checkBearer(
  request: Request,
  expected: string | undefined,
): Promise<AuthResult> {
  if (!expected) {
    return {
      ok: false,
      status: 503,
      reason: "SIMULATOR_TOKEN is not configured; refusing to accept writes",
    };
  }

  const header = request.headers.get("authorization") ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (presented === "") {
    return { ok: false, status: 401, reason: "missing bearer token" };
  }

  const [a, b] = await Promise.all([sha256(presented), sha256(expected)]);
  if (!crypto.subtle.timingSafeEqual(a, b)) {
    return { ok: false, status: 401, reason: "invalid bearer token" };
  }
  return { ok: true };
}
