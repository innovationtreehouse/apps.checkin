/**
 * Nav descriptors for the expense screens (#1272 §7). The library declares them; the host
 * places them. `EXPENSE_TABS` are the host-level tabs (Expense Ops and My Programs);
 * `EXPENSE_SUB_NAV` is the in-page navigation between FINANCE/Board screens under /expense.
 */

export interface ExpenseNavLink {
  name: string;
  href: string;
  /** Emoji icon (the host's SectionTabs render an emoji string). */
  icon: string;
}

export const EXPENSE_TABS = {
  expenses: { name: "Expenses", href: "/expense", icon: "🧾" },
  settings: { name: "Settings", href: "/expense/settings", icon: "⚙️" },
  approvals: { name: "Expense approvals", href: "/my-programs/expense-approvals", icon: "✍️" },
} as const satisfies Record<string, ExpenseNavLink>;

export const EXPENSE_SUB_NAV: readonly ExpenseNavLink[] = [
  { name: "Expenses", href: "/expense/expenses", icon: "🧾" },
  { name: "Holds", href: "/expense/holds", icon: "⛔" },
  { name: "Flags", href: "/expense/flags", icon: "🚩" },
  { name: "Account Mapping", href: "/expense/account-mapping", icon: "🗂️" },
  { name: "QB Accounts", href: "/expense/qb-accounts", icon: "📒" },
  { name: "Ownership Map", href: "/expense/ownership-map", icon: "🪣" },
  { name: "Capital Seed", href: "/expense/capital-seed", icon: "🏷️" },
];
