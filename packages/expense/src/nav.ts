/**
 * Nav descriptors for the expense screens (#1272 §7). The library declares them; the host
 * places them, orders them, and hides the FINANCE/Board-only ones from approvers.
 */

export interface ExpenseNavLink {
  name: string;
  href: string;
  /** Emoji icon (the host's SectionTabs render an emoji string). */
  icon: string;
  /** True for screens whose routes admit only FINANCE or Board. */
  financeOrBoard?: boolean;
}

export const EXPENSE_NAV_LINKS: readonly ExpenseNavLink[] = [
  { name: "Expenses", href: "/expense/expenses", icon: "🧾" },
  { name: "Holds", href: "/expense/holds", icon: "⛔", financeOrBoard: true },
  { name: "Flags", href: "/expense/flags", icon: "🚩", financeOrBoard: true },
  { name: "Account Mapping", href: "/expense/account-mapping", icon: "🗂️", financeOrBoard: true },
  { name: "QB Accounts", href: "/expense/qb-accounts", icon: "📒", financeOrBoard: true },
  { name: "Ownership Map", href: "/expense/ownership-map", icon: "🪣", financeOrBoard: true },
  { name: "Capital Seed", href: "/expense/capital-seed", icon: "🏷️", financeOrBoard: true },
  { name: "Settings", href: "/expense/settings", icon: "⚙️", financeOrBoard: true },
];
