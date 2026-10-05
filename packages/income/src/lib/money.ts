import { dollarsToCentsOrNull } from "@inventory/money";

/** Parse a CSV dollar string into integer cents. Returns 0 for empty/invalid input. */
export function toCents(val: string | undefined): number {
  return dollarsToCentsOrNull(val) ?? 0;
}

/** Parse a CSV dollar string into integer cents. Returns null for empty/invalid input. */
export { dollarsToCentsOrNull as toCentsNullable } from "@inventory/money";
