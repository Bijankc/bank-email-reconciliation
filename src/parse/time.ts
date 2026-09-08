import { ParseError } from "./errors";

/**
 * Timestamp normalization for the two bank formats.
 *
 * Both banks stamp Nepal local time (UTC+05:45) and neither states a zone. The
 * wall-clock reading is preserved verbatim and rendered with a `Z` suffix rather
 * than shifted to true UTC - see docs/DECISIONS.md 1.1. Because the same
 * treatment is applied to both banks, the relative ordering the chain sorts on
 * is identical either way.
 */

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/** NIMB: "12Mar26 09:14:22" (jammed DDMonYY plus time). */
const NIMB_STAMP = /^(\d{1,2})([A-Za-z]{3})(\d{2})\s+(\d{1,2}):(\d{2}):(\d{2})$/;

/** Nabil: "2026-03-12 10:05" - ISO-ish, seconds absent (spec 5.2). */
const NABIL_STAMP = /^(\d{4})-(\d{2})-(\d{2})[\sT](\d{1,2}):(\d{2})(?::(\d{2}))?$/;

function toIso(
  field: string,
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
): string {
  const millis = Date.UTC(year, month - 1, day, hour, minute, second);
  const date = new Date(millis);

  // Date.UTC rolls 31Feb over into March instead of failing. Round-tripping the
  // components catches that, so an impossible date is a parse error rather than
  // a silently wrong occurred_at that sorts into the wrong place in the chain.
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day ||
    date.getUTCHours() !== hour ||
    date.getUTCMinutes() !== minute ||
    date.getUTCSeconds() !== second
  ) {
    throw new ParseError(field, `not a real date: ${year}-${month}-${day} ${hour}:${minute}:${second}`);
  }

  return `${date.toISOString().slice(0, 19)}Z`;
}

export function parseNimbTimestamp(raw: string, field = "occurred_at"): string {
  const match = NIMB_STAMP.exec(raw.trim());
  if (match === null) {
    throw new ParseError(field, `expected DDMonYY HH:MM:SS, got ${JSON.stringify(raw)}`);
  }

  const month = MONTHS[match[2].toLowerCase()];
  if (month === undefined) {
    throw new ParseError(field, `unknown month abbreviation: ${match[2]}`);
  }

  // Two-digit year. These emails are current-transaction alerts, so a 19xx
  // reading is never right; 26 is 2026.
  return toIso(
    field,
    2000 + Number(match[3]),
    month,
    Number(match[1]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6]),
  );
}

export function parseNabilTimestamp(raw: string, field = "occurred_at"): string {
  const match = NABIL_STAMP.exec(raw.trim());
  if (match === null) {
    throw new ParseError(field, `expected YYYY-MM-DD HH:MM, got ${JSON.stringify(raw)}`);
  }

  // Nabil omits seconds; spec 5.2 pins the normalization to :00.
  return toIso(
    field,
    Number(match[1]),
    Number(match[2]),
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6] ?? "0"),
  );
}
