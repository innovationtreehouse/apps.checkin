/** What a FaultText prints as anywhere but its finance-only column. */
export const FAULT_TEXT_REDACTED = "[QuickBooks fault text: finance only]";

/** Node's util.inspect hook, by its registered name, so the module needs no Node import. */
const INSPECT = Symbol.for("nodejs.util.inspect.custom");

/** Longest fault text kept; QuickBooks' own messages run well under it. */
const MAX_FAULT_TEXT = 2000;

/**
 * The words of a QuickBooks fault, which can echo names and memos. They are stored for finance
 * alone, so the value prints redacted in a log line, a message, JSON and util.inspect; only
 * `reveal` returns the words, for the finance-only column.
 */
export class FaultText {
  readonly #text: string;

  constructor(text: string) {
    this.#text = text.slice(0, MAX_FAULT_TEXT);
  }

  reveal(): string {
    return this.#text;
  }

  toString(): string {
    return FAULT_TEXT_REDACTED;
  }

  toJSON(): string {
    return FAULT_TEXT_REDACTED;
  }

  [INSPECT](): string {
    return FAULT_TEXT_REDACTED;
  }
}

/** The fault text of a QBO Fault body's errors, one line each, or null when it carries none. */
export function faultTextOf(errors: readonly { Message?: unknown; Detail?: unknown }[]): FaultText | null {
  const lines = errors
    .map((e) => [e.Message, e.Detail].filter((part): part is string => typeof part === "string" && part.trim() !== "").join(": "))
    .filter((line) => line !== "");
  return lines.length ? new FaultText(lines.join("\n")) : null;
}
