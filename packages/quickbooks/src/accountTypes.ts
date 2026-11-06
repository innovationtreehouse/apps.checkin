/**
 * Which QuickBooks account types each books-map role and each per-item line
 * accepts (docs/rules/revenue.md). The books map's save, every account picker
 * and System Status read these lists; values are QuickBooks' AccountType names.
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
