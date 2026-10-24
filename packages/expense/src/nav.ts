/**
 * Nav descriptors for the expense screens (#1272 §7). The library declares them; the host
 * places them: `EXPENSE_OPS_TABS` then `EXPENSE_TABS.settings` as the Expense Ops tabs, and
 * `EXPENSE_TABS.approvals` under Programs I Lead.
 */

/**
 * The Expense Ops nav counts expense reports to the host, one per badged tab. `actionable` is the
 * sum of the per-view action counts.
 */
export type ExpenseNavCount = "holds" | "openFlags" | "actionable";

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
  /** Which ExpenseNavCount badges this tab, if any. */
  badge?: ExpenseNavCount;
}

export const EXPENSE_TABS = {
  settings: { name: "Settings", href: "/expense/settings", icon: "⚙️" },
  approvals: { name: "Expense approvals", href: "/programs-i-lead/expense-approvals", icon: "✍️" },
} as const satisfies Record<string, ExpenseNavLink>;

/** The FINANCE/Board expense screens, each an Expense Ops tab. */
export const EXPENSE_OPS_TABS: readonly ExpenseNavLink[] = [
  { name: "Expenses", href: "/expense/expenses", icon: "🧾", badge: "actionable" },
  { name: "Holds", href: "/expense/holds", icon: "⛔", badge: "holds" },
  { name: "Flags", href: "/expense/flags", icon: "🚩", badge: "openFlags" },
  { name: "Account Mapping", href: "/expense/account-mapping", icon: "🗂️" },
  { name: "QuickBooks Accounts", href: "/expense/qb-accounts", icon: "📒" },
  { name: "Part Buckets", href: "/expense/ownership-map", icon: "🪣" },
  { name: "Capital Seed", href: "/expense/capital-seed", icon: "🏷️" },
];
