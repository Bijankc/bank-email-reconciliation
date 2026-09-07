/**
 * A parse failure that is the message's fault, not the code's.
 *
 * These are not retryable: re-running the same parser over the same bytes will
 * fail the same way. Phase 2 uses that distinction to decide between acking a
 * malformed email and letting the queue retry a transient failure.
 */
export class ParseError extends Error {
  readonly field: string;

  constructor(field: string, message: string) {
    super(`${field}: ${message}`);
    this.name = "ParseError";
    this.field = field;
  }
}
