/**
 * Bearer-token check for the write endpoints.
 *
 * There are two secrets, not one, because the routes guard different things:
 * SIMULATOR_TOKEN admits an event to the pipeline, OPERATOR_TOKEN records a
 * human accepting a real discrepancy. This function is given whichever one the
 * route requires, and knows nothing about which is which.
 *
 * Two properties matter here and both are deliberate:
 *  - Fail closed. If the expected secret is unset, every request is rejected.
 *    An unset secret must never mean "auth disabled" on a public deployment.
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
  secretName = "the required secret",
): Promise<AuthResult> {
  if (!expected) {
    // Names the missing secret, because with two of them "not configured" on
    // its own sends you looking at the wrong one.
    return {
      ok: false,
      status: 503,
      reason: `${secretName} is not configured; refusing to accept writes`,
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
