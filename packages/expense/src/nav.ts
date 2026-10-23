/**
 * Nav descriptors for the expense screens (#1272 §7). The library declares them; the host
 * places them: `EXPENSE_OPS_TABS` then `EXPENSE_TABS.settings` as the Expense Ops tabs, and
 * `EXPENSE_TABS.approvals` under Programs I Lead.
 */

/** The Expense Ops nav counts expense reports to the host, one per badged tab. */
export type ExpenseNavCount = "holds" | "openFlags";

export interface ExpenseNavLink {
  name: string;
  href: string;
  /** Emoji icon (the host's SectionTabs render an emoji string). */
  icon: string;
  /** Which ExpenseNavCount badges this tab, if any. */
  badge?: ExpenseNavCount;
}

export const EXPENSE_TABS = {
  settings: { name: "Settings", href: "/expense/settings", icon: "⚙️" },
  approvals: { name: "Expense approvals", href: "/programs-i-lead/expense-approvals", icon: "✍️" },
} as const satisfies Record<string, ExpenseNavLink>;

/** The FINANCE/Board expense screens, each an Expense Ops tab. */
export const EXPENSE_OPS_TABS: readonly ExpenseNavLink[] = [
  { name: "Expenses", href: "/expense/expenses", icon: "🧾" },
  { name: "Holds", href: "/expense/holds", icon: "⛔", badge: "holds" },
  { name: "Flags", href: "/expense/flags", icon: "🚩", badge: "openFlags" },
  { name: "Account Mapping", href: "/expense/account-mapping", icon: "🗂️" },
  { name: "QB Accounts", href: "/expense/qb-accounts", icon: "📒" },
  { name: "Ownership Map", href: "/expense/ownership-map", icon: "🪣" },
  { name: "Capital Seed", href: "/expense/capital-seed", icon: "🏷️" },
];
