import type { Direction } from "./types";

/**
 * The balance chain (spec 6.1), extracted so that exactly one implementation
 * exists.
 *
 * The Durable Object runs this over its own event table to decide what is
 * reconciled; the read API runs it over the projected D1 rows to render the
 * same timeline. If the two had separate copies they would eventually disagree,
 * and the projected-versus-authoritative toggle would be showing a bug rather
 * than replication lag.
 */

/** The minimum a row needs for the chain to say anything about it. */
export interface ChainEvent {
  event_id: string;
  occurred_at: string;
  direction: Direction;
  amount_paisa: number;
  reported_balance_paisa: number;
}

/** What the chain says about the adjacency ending at one event. */
export interface ChainMarks {
  /** Null for the first event: an anchor has nothing before it to chain from. */
  expected_balance_paisa: number | null;
  delta_paisa: number | null;
  chains: boolean | null;
}

/** CREDIT adds, DEBIT subtracts. The amount itself is always positive. */
export function signedMovement(event: {
  direction: Direction;
  amount_paisa: number;
}): number {
  return event.direction === "CREDIT" ? event.amount_paisa : -event.amount_paisa;
}

/**
 * Order events that share an occurred_at.
 *
 * Nabil stamps its alerts to the minute, so two transactions in the same minute
 * carry identical timestamps and the log alone cannot say which came first. The
 * arbitrary choice is not neutral: pick wrong and two perfectly consistent
 * transactions produce a gap that never existed, which is the fastest way for a
 * reconciliation tool to stop being believed.
 *
 * So the balances are used to recover the order. Starting from the balance the
 * chain has already reached, repeatedly take whichever tied event chains from
 * it. When no arrangement chains - a genuine gap inside the tie - the remainder
 * keeps event_id order, which is deterministic, and the mismatch is reported.
 */
function arrangeTie<T extends ChainEvent>(
  group: T[],
  anchorBalance: number | null,
): T[] {
  if (anchorBalance === null || group.length < 2) return group;

  const remaining = [...group];
  const ordered: T[] = [];
  let balance = anchorBalance;

  for (;;) {
    const index = remaining.findIndex(
      (event) => event.reported_balance_paisa === balance + signedMovement(event),
    );
    if (index === -1) break;
    const [picked] = remaining.splice(index, 1);
    ordered.push(picked);
    balance = picked.reported_balance_paisa;
  }

  return [...ordered, ...remaining];
}

/**
 * Put an account's events into chain order: by occurred_at, with ties resolved
 * against the running balance. Input order does not matter, which is what makes
 * out-of-order arrival converge.
 */
export function orderChain<T extends ChainEvent>(rows: readonly T[]): T[] {
  const sorted = [...rows].sort((a, b) =>
    a.occurred_at === b.occurred_at
      ? a.event_id.localeCompare(b.event_id)
      : a.occurred_at.localeCompare(b.occurred_at),
  );

  const ordered: T[] = [];
  let index = 0;
  while (index < sorted.length) {
    let end = index;
    while (
      end < sorted.length &&
      sorted[end].occurred_at === sorted[index].occurred_at
    ) {
      end += 1;
    }
    const anchor =
      ordered.length > 0
        ? ordered[ordered.length - 1].reported_balance_paisa
        : null;
    ordered.push(...arrangeTie(sorted.slice(index, end), anchor));
    index = end;
  }

  return ordered;
}

/**
 * Order the events and evaluate every adjacency. Reconciliation is a property
 * of adjacencies, not of events, so the marks belong to the pair and are
 * recorded on its later half.
 */
export function evaluateChain<T extends ChainEvent>(
  rows: readonly T[],
): (T & ChainMarks)[] {
  const ordered = orderChain(rows);

  return ordered.map((event, position) => {
    if (position === 0) {
      return {
        ...event,
        expected_balance_paisa: null,
        delta_paisa: null,
        chains: null,
      };
    }

    const expected =
      ordered[position - 1].reported_balance_paisa + signedMovement(event);

    return {
      ...event,
      expected_balance_paisa: expected,
      delta_paisa: event.reported_balance_paisa - expected,
      chains: event.reported_balance_paisa === expected,
    };
  });
}
