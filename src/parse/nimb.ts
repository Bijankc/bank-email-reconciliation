import { ParseError } from "./errors";
import type { ParsedFields } from "./fields";
import { parsePaisa } from "./money";
import { parseNimbTimestamp } from "./time";

/**
 * NIMB parser: plain-text prose (spec 5.2).
 *
 *   Your a/c 099XX4417 has been Debited by NPR 1,450.00 on 12Mar26 09:14:22.
 *   The transaction detail is 88213047qLmT,coffee,401228865,...,55210.
 *   Available Balance on 12Mar26 09:15:01 is NPR 7,310.55
 *
 * Note the two timestamps. The first is when the money moved, the second is when
 * the balance was read; they differ by 39 seconds in the sample above. The chain
 * orders transactions, so occurred_at is the movement time - using the
 * balance-read time would sort events by when the bank got round to looking.
 */

const MOVEMENT =
  /a\/c\s+([0-9A-Za-z*]+)\s+has\s+been\s+(Debited|Credited)\s+by\s+NPR\s*([\d,]+(?:\.\d{1,2})?)\s+on\s+(\d{1,2}[A-Za-z]{3}\d{2}\s+\d{1,2}:\d{2}:\d{2})/i;

const BALANCE =
  /Available\s+Balance\s+(?:on\s+\d{1,2}[A-Za-z]{3}\d{2}\s+\d{1,2}:\d{2}:\d{2}\s+)?is\s+NPR\s*([\d,]+(?:\.\d{1,2})?)/i;

const DETAIL = /transaction\s+detail\s+is\s+([^\r\n]+)/i;

export function parseNimbText(text: string): ParsedFields {
  const movement = MOVEMENT.exec(text);
  if (movement === null) {
    throw new ParseError("movement", "no NIMB debit/credit sentence in the message body");
  }

  const balance = BALANCE.exec(text);
  if (balance === null) {
    // Without the reported balance there is nothing to reconcile against, so
    // this is a hard failure rather than a null field.
    throw new ParseError("reported_balance_paisa", "no Available Balance line in the message body");
  }

  const { reference, merchant } = parseDetailBlob(text);

  return {
    account_label: movement[1],
    direction: movement[2].toLowerCase() === "debited" ? "DEBIT" : "CREDIT",
    amount_paisa: parsePaisa(movement[3], "amount_paisa"),
    reported_balance_paisa: parsePaisa(balance[1], "reported_balance_paisa"),
    occurred_at: parseNimbTimestamp(movement[4]),
    merchant,
    reference,
  };
}

/**
 * The detail line is a positional comma blob:
 * `88213047qLmT,coffee,401228865,1111020009443317,55210`. First token is the
 * bank reference, second is the closest thing to a memo. This is the most
 * brittle parse in the project - the fields are unlabelled, so a bank that
 * inserts a column silently shifts the merchant and, worse, the reference that
 * the idempotency key is built from.
 *
 * Both fields are optional rather than fatal: a missing reference degrades the
 * event_id to the hash derivation (spec 5.4), which still dedups.
 */
function parseDetailBlob(text: string): { reference: string | null; merchant: string | null } {
  const detail = DETAIL.exec(text);
  if (detail === null) return { reference: null, merchant: null };

  const tokens = detail[1]
    .replace(/\.\s*$/, "")
    .split(",")
    .map((token) => token.trim());

  const reference = tokens[0] !== undefined && tokens[0] !== "" ? tokens[0] : null;
  const merchant = tokens[1] !== undefined && tokens[1] !== "" ? tokens[1] : null;
  return { reference, merchant };
}
