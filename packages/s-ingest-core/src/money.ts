/**
 * Money is signed integer cents everywhere. Parsing/rounding is delegated to the
 * shared @checkin/money library so this service rounds identically to the rest of
 * the monorepo — important for the later cross-DB reconciliation with income-app.
 */
import { dollarsToCents } from "@checkin/money";

/** Signed integer cents from a Shopify money amount; 0 for null/blank, throws on garbage. */
export function toCents(amount: string | number | null | undefined): number {
  if (amount === null || amount === undefined || amount === "") return 0;
  return dollarsToCents(amount);
}

/** Extract signed cents from a Shopify MoneyV2 shape. */
export function moneyV2ToCents(money: { amount?: string | number | null } | null | undefined): number {
  return toCents(money?.amount ?? 0);
}
