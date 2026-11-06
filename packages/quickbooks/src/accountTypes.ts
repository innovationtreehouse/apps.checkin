/**
 * Which QuickBooks account types each books-map role and each per-item line
 * accepts (docs/rules/revenue.md). Every account save and picker, and System
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
  SHOPIFY_SALES: LINE_ACCOUNT_TYPES.storeSale,
  SHOPIFY_CHARGE_REMAINDER: [...INCOME, "Other Current Liability"],
  SHOPIFY_FEES: EXPENSE,
  SHOPIFY_ADJUSTMENTS: [...INCOME, "Other Current Liability"],
  BENEVITY_BANK: ["Bank"],
  BENEVITY_DONATIONS: LINE_ACCOUNT_TYPES.givingGift,
  BENEVITY_MATCHES: LINE_ACCOUNT_TYPES.givingGift,
  BENEVITY_FEES: EXPENSE,
  EXPENSE_PAYMENT: ["Bank", "Credit Card"],
  INKIND_INCOME: INCOME,
  INKIND_EXPENSE: LINE_ACCOUNT_TYPES.donatedGoods,
  FIXED_ASSETS: LINE_ACCOUNT_TYPES.donatedCapital,
  INKIND_CLEARING: ["Bank", "Other Current Asset", "Other Current Liability"],
};

/** One QuickBooks account as an account-type check reads it. */
export interface QboAccountSummary {
  id: string;
  name: string;
  accountType: string;
}

/** The host's live read of QuickBooks' accounts; throws a 503 while QuickBooks can't be read. */
export type QboAccountList = () => Promise<readonly QboAccountSummary[]>;

const either = new Intl.ListFormat("en", { type: "disjunction" });

/** "an Expense or Other Expense account": the types a line or role accepts, as finance reads them. */
export function acceptedAccountTypes(types: readonly string[]): string {
  return `${/^[AEIOU]/.test(types[0]) ? "an" : "a"} ${either.format(types)} account`;
}

/** Why `what` can't take account `id`, in finance's words; null when QuickBooks lists it under an allowed type. */
export function accountTypeRefusal(accounts: readonly QboAccountSummary[], id: string, allowed: readonly string[], what: string): string | null {
  const account = accounts.find((a) => a.id === id);
  if (!account) return `QuickBooks has no account with id ${id}`;
  if (allowed.includes(account.accountType)) return null;
  return `${what} takes ${acceptedAccountTypes(allowed)}; ${account.name} is ${account.accountType}`;
}
