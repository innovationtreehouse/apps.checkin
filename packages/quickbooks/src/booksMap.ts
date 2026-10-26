/**
 * The books map: which QuickBooks account each named role books to, and which
 * QuickBooks Class each budget bucket books to. Finance edits it in the host;
 * income, gifts of goods and expense read it through this port, which the host
 * binds. Donation deposits still take their bank account from the host's settings.
 */

/** The named roles a line or a deposit books to, one QuickBooks account each. */
export const BOOKS_MAP_ROLES = [
  "SHOPIFY_BANK",
  "SHOPIFY_SALES",
  "SHOPIFY_CHARGE_REMAINDER",
  "SHOPIFY_FEES",
  "SHOPIFY_ADJUSTMENTS",
  "BENEVITY_BANK",
  "BENEVITY_DONATIONS",
  "BENEVITY_MATCHES",
  "BENEVITY_FEES",
  "EXPENSE_PAYMENT",
  "INKIND_INCOME",
  "INKIND_EXPENSE",
  "FIXED_ASSETS",
  "INKIND_CLEARING",
] as const;

export type BooksMapRole = (typeof BOOKS_MAP_ROLES)[number];

export function isBooksMapRole(value: string): value is BooksMapRole {
  return (BOOKS_MAP_ROLES as readonly string[]).includes(value);
}

export interface BooksMap {
  /** QuickBooks account id per role; a role finance has not set is absent. */
  accounts(): Promise<Partial<Record<BooksMapRole, string>>>;
  /** QuickBooks Class id per budget-bucket id; a bucket without a Class is absent. */
  classes(): Promise<ReadonlyMap<number, string>>;
}
