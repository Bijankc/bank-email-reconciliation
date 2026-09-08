import { deriveEventId } from "./parse/event-id";
import {
  SCHEMA_VERSION,
  type Bank,
  type Direction,
  type TxnEvent,
} from "./types";

/**
 * Validation for the simulator ingress (spec 5.5): POST /webhook receives an
 * already-normalized event rather than an email, so this is the only place a
 * caller can hand the engine a transaction the parsers did not build.
 *
 * That makes it the trust boundary. The parsers cannot emit a float amount or
 * an impossible direction; an HTTP client can. Every invariant the rest of the
 * system relies on is asserted here rather than assumed:
 *
 *  - money is an integer number of paisa (spec 5.3), so a body carrying
 *    2200.5 is rejected instead of being rounded into the ledger;
 *  - account_id is {bank}:{masked account} (spec 5.1), because the ledger
 *    Durable Object is addressed by that string and a mismatched prefix would
 *    silently open a second ledger for the same account;
 *  - occurred_at is a real instant in the one format the chain sorts on.
 *
 * Every failure is collected rather than thrown on the first problem: the
 * simulator panel in Phase 6 posts hand-edited JSON, and one round trip per
 * mistake is a poor way to find three of them.
 */

const BANKS: readonly Bank[] = ["NIMB", "NABIL"];
const DIRECTIONS: readonly Direction[] = ["DEBIT", "CREDIT"];

/** The one shape the chain sorts on. Matches what the parsers emit. */
const ISO_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/;

export interface FieldError {
  field: string;
  message: string;
}

export type ValidationResult =
  | { ok: true; event: TxnEvent }
  | { ok: false; errors: FieldError[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Optional free text: absent, null, or blank all normalize to null. */
function optionalText(
  value: unknown,
  field: string,
  errors: FieldError[],
): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    errors.push({ field, message: "must be a string or null" });
    return null;
  }
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function isRealInstant(iso: string): boolean {
  const match = ISO_INSTANT.exec(iso);
  if (match === null) return false;
  const [, y, mo, d, h, mi, s] = match.map(Number);
  const date = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
  // Date.UTC rolls 2026-02-31 forward into March rather than failing, so the
  // components are round-tripped to catch a date that does not exist.
  return (
    date.getUTCFullYear() === y &&
    date.getUTCMonth() === mo - 1 &&
    date.getUTCDate() === d &&
    date.getUTCHours() === h &&
    date.getUTCMinutes() === mi &&
    date.getUTCSeconds() === s
  );
}

/**
 * Money arriving from outside. Rejects anything that is not already an exact
 * integer count of paisa, which is what stops 2200.5 from being quietly
 * floored into a ledger that then fails to reconcile by half a paisa.
 */
function paisa(
  value: unknown,
  field: string,
  errors: FieldError[],
  options: { positive: boolean },
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    errors.push({ field, message: "must be a number of paisa (integer)" });
    return 0;
  }
  if (!Number.isInteger(value)) {
    errors.push({
      field,
      message: `must be integer paisa, not rupees or a fraction: got ${value}`,
    });
    return 0;
  }
  if (!Number.isSafeInteger(value)) {
    errors.push({ field, message: "exceeds the safe integer range" });
    return 0;
  }
  if (options.positive && value <= 0) {
    errors.push({
      field,
      message: "must be positive; direction carries the sign, not the amount",
    });
    return 0;
  }
  return value;
}

/**
 * Validate an untrusted body into a TxnEvent, deriving whatever the caller left
 * out. Returns every problem it found rather than the first.
 */
export async function validateTxnEvent(
  body: unknown,
): Promise<ValidationResult> {
  const errors: FieldError[] = [];

  if (!isRecord(body)) {
    return {
      ok: false,
      errors: [{ field: "body", message: "must be a JSON object" }],
    };
  }

  // Versioning is additive-only (spec 9), so a field this Worker does not know
  // about is harmless and is ignored. A higher schema_version is not: it means
  // the producer changed something this code cannot see, and guessing is worse
  // than refusing.
  const version = body.schema_version ?? SCHEMA_VERSION;
  if (version !== SCHEMA_VERSION) {
    errors.push({
      field: "schema_version",
      message: `unsupported schema_version ${String(version)}; this Worker speaks ${SCHEMA_VERSION}`,
    });
  }

  const bank = body.bank;
  if (typeof bank !== "string" || !BANKS.includes(bank as Bank)) {
    errors.push({ field: "bank", message: `must be one of ${BANKS.join(", ")}` });
  }

  const direction = body.direction;
  if (
    typeof direction !== "string" ||
    !DIRECTIONS.includes(direction as Direction)
  ) {
    errors.push({
      field: "direction",
      message: `must be one of ${DIRECTIONS.join(", ")}`,
    });
  }

  const amount = paisa(body.amount_paisa, "amount_paisa", errors, {
    positive: true,
  });
  // A balance may legitimately be zero or negative: an overdrawn account is a
  // real state, and rejecting it would lose exactly the events worth seeing.
  const balance = paisa(
    body.reported_balance_paisa,
    "reported_balance_paisa",
    errors,
    { positive: false },
  );

  const occurredAt = body.occurred_at;
  if (typeof occurredAt !== "string" || !isRealInstant(occurredAt)) {
    errors.push({
      field: "occurred_at",
      message: "must be YYYY-MM-DDTHH:MM:SSZ and a date that exists",
    });
  }

  const accountId = body.account_id;
  if (typeof accountId !== "string" || accountId.trim() === "") {
    errors.push({ field: "account_id", message: "is required" });
  } else if (typeof bank === "string" && !accountId.startsWith(`${bank}:`)) {
    // The ledger DO is addressed by account_id. A prefix that disagrees with
    // the bank field would open a second, parallel ledger for the same real
    // account, and each would reconcile against half the transactions.
    errors.push({
      field: "account_id",
      message: `must start with ${bank}: to match the bank field`,
    });
  } else if (
    typeof bank === "string" &&
    accountId.slice(bank.length + 1).trim() === ""
  ) {
    errors.push({
      field: "account_id",
      message: "carries no account number after the bank prefix",
    });
  }

  const merchant = optionalText(body.merchant, "merchant", errors);
  const reference = optionalText(body.reference, "reference", errors);
  const label = optionalText(body.account_label, "account_label", errors);

  const suppliedId = body.event_id;
  if (suppliedId !== undefined && suppliedId !== null) {
    if (typeof suppliedId !== "string" || suppliedId.trim() === "") {
      errors.push({
        field: "event_id",
        message: "must be a non-empty string when supplied",
      });
    } else if (typeof bank === "string" && !suppliedId.startsWith(`${bank}:`)) {
      errors.push({ field: "event_id", message: `must start with ${bank}:` });
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  const checkedBank = bank as Bank;
  const checkedAccountId = accountId as string;
  const checkedOccurredAt = occurredAt as string;
  const checkedDirection = direction as Direction;

  // An omitted event_id is derived exactly as the parsers derive it, so posting
  // the same transaction twice produces the same id and dedups downstream
  // without the caller having to know the rule.
  const derived = await deriveEventId({
    bank: checkedBank,
    account_id: checkedAccountId,
    occurred_at: checkedOccurredAt,
    direction: checkedDirection,
    amount_paisa: amount,
    reference,
  });

  const eventId =
    typeof suppliedId === "string" ? suppliedId.trim() : derived.event_id;
  // When the caller supplies an id, the method is read back off the id itself
  // rather than trusted from the body: it counts as "reference" only if the id
  // really is the reference, and that flag is what the README calls out as the
  // weaker of the two keys.
  const method =
    typeof suppliedId === "string"
      ? reference !== null && eventId === `${checkedBank}:${reference}`
        ? "reference"
        : "hash"
      : derived.event_id_method;

  return {
    ok: true,
    event: {
      event_id: eventId,
      event_id_method: method,
      account_id: checkedAccountId,
      account_label:
        label ?? checkedAccountId.slice(checkedBank.length + 1),
      bank: checkedBank,
      direction: checkedDirection,
      amount_paisa: amount,
      reported_balance_paisa: balance,
      occurred_at: checkedOccurredAt,
      merchant,
      reference,
      // Provenance is decided by the endpoint the event arrived on, never by
      // the body. A simulator event able to label itself "email" would leave
      // the audit trail unable to answer where a transaction came from.
      source_channel: "simulator",
      schema_version: SCHEMA_VERSION,
    },
  };
}
