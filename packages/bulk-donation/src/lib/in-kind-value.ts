// How a receipt gift's lines take its total. Pure, so the accept screen and the server agree on which lines finance values.
import { allocateCents } from "@checkin/money";

/**
 * Spreads the difference between `totalCents` and the values (a receipt's tax, shipping or
 * discount) across them by value, so they sum to the total exactly.
 */
export function spreadToTotal(values: number[], totalCents: number): number[] {
  if (values.length === 0) return [];
  const extra = allocateCents(totalCents - values.reduce((a, b) => a + b, 0), values);
  return values.map((v, i) => v + extra[i]);
}

/** Which receipt lines finance values: one the receipt priced at $0, or one whose share of the receipt total comes to $0. */
export function freeLines(prices: number[], receiptTotalCents: number): boolean[] {
  const shares = spreadToTotal(prices, receiptTotalCents);
  return prices.map((price, i) => price === 0 || shares[i] <= 0);
}
