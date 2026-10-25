/**
 * Nav descriptors for the expense screens (#1272 §7). The library declares them; the host
 * places them: `EXPENSE_FINANCE_TABS` and `EXPENSE_TABS.settings` in the Finance section, and
 * `EXPENSE_TABS.approvals` under Programs I Lead.
 */

/** The finance queue's actionable units, under this key in the expense library's nav counts. */
export const FINANCE_QUEUE_COUNT_KEY = "financeQueue";

/** The expense list views that carry an action count: the items in the view the viewer can act on. */
export const EXPENSE_ACTION_VIEWS = [
  "assign_ownership",
  "owner_approval",
  "owner_exception",
  "capital_review",
  "set_depreciation_cycle",
  "qb_pending",
] as const;
export type ExpenseActionView = (typeof EXPENSE_ACTION_VIEWS)[number];

/** The key a view's action count rides under in the expense library's nav counts. */
export function expenseActionCountKey(view: ExpenseActionView): string {
  return `actionable:${view}`;
}

export interface ExpenseNavLink {
  name: string;
  href: string;
  /** Emoji icon (the host's SectionTabs render an emoji string). */
  icon: string;
}

export const EXPENSE_TABS = {
  settings: { name: "Settings", href: "/expense/settings", icon: "⚙️" },
  approvals: { name: "Expense approvals", href: "/programs-i-lead/expense-approvals", icon: "✍️" },
} as const satisfies Record<string, ExpenseNavLink>;

/** The FINANCE/Board expense screens: the browse list, then the bookkeeping setup screens. */
export const EXPENSE_FINANCE_TABS = {
  expenses: { name: "Expenses", href: "/expense/expenses", icon: "🧾" },
  setup: [
    { name: "Account Mapping", href: "/expense/account-mapping", icon: "🗂️" },
    { name: "QuickBooks Accounts", href: "/expense/qb-accounts", icon: "📒" },
    { name: "Part Buckets", href: "/expense/ownership-map", icon: "🪣" },
    { name: "Capital Seed", href: "/expense/capital-seed", icon: "🏷️" },
  ],
} as const satisfies { expenses: ExpenseNavLink; setup: readonly ExpenseNavLink[] };
