/**
 * Which QuickBooks account types each books-map role and each per-item line
 * accepts. Every account save and picker, and System
 * Status, read these lists; values are QuickBooks' AccountType names.
 */
import type { BooksMapRole } from "./booksMap";

const INCOME = ["Income", "Other Income"] as const;
const EXPENSE = ["Expense", "Other Expense"] as const;
const EXPENSE_OR_COST = ["Expense", "Other Expense", "Cost of Goods Sold"] as const;

/** The types a per-item line accepts, by what the line is. */
export const LINE_ACCOUNT_TYPES = {
  storeSale: INCOME,
  customItem: INCOME,
  givingGift: INCOME,
  donatedGoods: EXPENSE_OR_COST,
  donatedCapital: ["Fixed Asset"],
} as const satisfies Record<string, readonly string[]>;

/** The types each books-map role accepts. */
export const BOOKS_MAP_ROLE_ACCOUNT_TYPES: Record<BooksMapRole, readonly string[]> = {
  SHOPIFY_BANK: ["Bank"],
  SHOPIFY_CHARGE_REMAINDER: [...INCOME, "Other Current Liability"],
  SHOPIFY_FEES: EXPENSE,
  SHOPIFY_ADJUSTMENTS: [...INCOME, "Other Current Liability"],
  SHOPIFY_CUSTOM_ITEMS: LINE_ACCOUNT_TYPES.customItem,
  BENEVITY_BANK: ["Bank"],
  EXPENSE_PAYMENT: ["Bank", "Credit Card"],
  INKIND_INCOME: INCOME,
  INKIND_CLEARING: ["Bank", "Other Current Asset", "Other Current Liability"],
};

/** One QuickBooks account as an account-type check reads it. */
export interface QboAccountSummary {
  id: string;
  name: string;
  accountType: string;
  active: boolean;
}

/** The host's read of its copy of QuickBooks' accounts. */
export type QboAccountList = () => Promise<readonly QboAccountSummary[]>;

const either = new Intl.ListFormat("en", { type: "disjunction" });

/** "an Expense or Other Expense account": the types a line or role accepts, as finance reads them. */
export function acceptedAccountTypes(types: readonly string[]): string {
  return `${/^[AEIOU]/.test(types[0]) ? "an" : "a"} ${either.format(types)} account`;
}

/** Why `what` can't take account `id`, in finance's words; null when the app's QuickBooks list holds it, active, under an allowed type. */
export function accountTypeRefusal(accounts: readonly QboAccountSummary[], id: string, allowed: readonly string[], what: string): string | null {
  const account = accounts.find((a) => a.id === id);
  if (!account) return `QuickBooks' list in the app doesn't have an account with id ${id}`;
  if (!account.active) return `QuickBooks' list in the app shows ${account.name} as inactive`;
  if (allowed.includes(account.accountType)) return null;
  return `${what} takes ${acceptedAccountTypes(allowed)}; QuickBooks' list in the app shows ${account.name} as ${account.accountType}`;
}

/** The error code of a save refused because the app's QuickBooks list lacks the pick, shows it inactive, or holds it under another type. */
export const QUICKBOOKS_LIST_STALE = "quickbooks-list-stale";

/** What a save refused against the app's QuickBooks list tells finance to do next. */
export const UPDATE_NOW_HINT = "If you changed it in QuickBooks, press Update now, then save again.";

/** accountTypeRefusal for a save, followed by the Update now hint. */
export function staleListRefusal(accounts: readonly QboAccountSummary[], id: string, allowed: readonly string[], what: string): string | null {
  const refusal = accountTypeRefusal(accounts, id, allowed, what);
  return refusal && `${refusal}. ${UPDATE_NOW_HINT}`;
}
