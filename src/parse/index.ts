import PostalMime, { type Address } from "postal-mime";
import { SCHEMA_VERSION, type Bank, type TxnEvent } from "../types";
import { ParseError } from "./errors";
import { deriveEventId } from "./event-id";
import type { ParsedFields } from "./fields";
import { htmlToText } from "./html";
import { parseNabilHtml } from "./nabil";
import { parseNimbText } from "./nimb";

export { ParseError } from "./errors";
export type { ParsedFields } from "./fields";

/**
 * Ingress parsing: raw MIME bytes in, one normalized TxnEvent out (spec 5.1).
 *
 * Two banks, two shapes, one contract. Everything downstream of this module -
 * queue, ledger, projection, dashboard - is written against TxnEvent and never
 * learns that NIMB sends prose and Nabil sends a table.
 */

const SENDERS: Array<{ bank: Bank; domain: RegExp }> = [
  { bank: "NIMB", domain: /(^|[.@])nimb\.com\.np$/i },
  { bank: "NABIL", domain: /(^|[.@])nabilbank\.com$/i },
];

/** Content shape, used only when the sender domain is not recognised. */
const SIGNATURES: Array<{ bank: Bank; pattern: RegExp }> = [
  { bank: "NIMB", pattern: /has\s+been\s+(?:Debited|Credited)\s+by\s+NPR/i },
  { bank: "NABIL", pattern: /transaction\s*date/i },
];

export interface EmailParts {
  from: string;
  subject: string | null;
  text: string | null;
  html: string | null;
}

function addressOf(address: Address | undefined): string {
  if (address === undefined) return "";
  return address.address ?? address.group?.[0]?.address ?? "";
}

export async function extractParts(raw: string): Promise<EmailParts> {
  const email = await PostalMime.parse(raw);
  return {
    from: addressOf(email.from).toLowerCase(),
    subject: email.subject ?? null,
    text: email.text ?? null,
    html: email.html ?? null,
  };
}

export function detectBank(parts: EmailParts): Bank | null {
  const domain = parts.from.split("@")[1] ?? "";
  for (const sender of SENDERS) {
    if (sender.domain.test(domain)) return sender.bank;
  }

  // A forward can rewrite the envelope sender, so the sender domain is a strong
  // hint rather than the only evidence. Falling back to the body shape keeps a
  // Gmail-forwarded alert parseable.
  const body = `${parts.text ?? ""}\n${parts.html === null ? "" : htmlToText(parts.html)}`;
  for (const signature of SIGNATURES) {
    if (signature.pattern.test(body)) return signature.bank;
  }

  return null;
}

async function parseFields(bank: Bank, parts: EmailParts): Promise<ParsedFields> {
  if (bank === "NIMB") {
    // NIMB is a plain-text sender, but a multipart alert still has to parse, so
    // the HTML part is flattened rather than refused.
    const text = parts.text ?? (parts.html === null ? null : htmlToText(parts.html));
    if (text === null) throw new ParseError("body", "message has no text or HTML part");
    return parseNimbText(text);
  }

  if (parts.html === null) {
    throw new ParseError("body", "Nabil alert has no HTML part to read the table from");
  }
  return parseNabilHtml(parts.html);
}

/** Compose the parsed facts into the event contract. Both banks land here. */
export async function normalize(bank: Bank, fields: ParsedFields): Promise<TxnEvent> {
  const account_id = `${bank}:${fields.account_label}`;
  const derived = await deriveEventId({
    bank,
    account_id,
    occurred_at: fields.occurred_at,
    direction: fields.direction,
    amount_paisa: fields.amount_paisa,
    reference: fields.reference,
  });

  return {
    event_id: derived.event_id,
    event_id_method: derived.event_id_method,
    account_id,
    account_label: fields.account_label,
    bank,
    direction: fields.direction,
    amount_paisa: fields.amount_paisa,
    reported_balance_paisa: fields.reported_balance_paisa,
    occurred_at: fields.occurred_at,
    merchant: fields.merchant,
    reference: fields.reference,
    source_channel: "email",
    schema_version: SCHEMA_VERSION,
  };
}

export type ParseOutcome =
  | { ok: true; bank: Bank; event: TxnEvent }
  | { ok: false; bank: Bank | null; field: string; message: string };

/**
 * Parse raw MIME into a normalized event.
 *
 * Returns a result rather than throwing, because a message this parser cannot
 * read is not an exception - it is an expected outcome with its own handling.
 * From Phase 2 on, the distinction matters: a parse failure must be acked and
 * recorded, never retried, since re-running the same parser over the same bytes
 * fails identically and would only fill the dead-letter queue.
 */
export async function parseBankEmail(raw: string): Promise<ParseOutcome> {
  let parts: EmailParts;
  try {
    parts = await extractParts(raw);
  } catch (error) {
    return { ok: false, bank: null, field: "mime", message: String(error) };
  }

  const bank = detectBank(parts);
  if (bank === null) {
    return { ok: false, bank: null, field: "bank", message: `unrecognised sender: ${parts.from || "(none)"}` };
  }

  try {
    const event = await normalize(bank, await parseFields(bank, parts));
    return { ok: true, bank, event };
  } catch (error) {
    if (error instanceof ParseError) {
      return { ok: false, bank, field: error.field, message: error.message };
    }
    throw error;
  }
}
