/**
 * Nav descriptors for the expense screens (#1272 §7). The library declares them; the host
 * places them: `EXPENSE_FINANCE_TABS` in the Finance section, `EXPENSE_TABS.settings` under
 * Settings, and `EXPENSE_TABS.approvals` under Programs I Lead.
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

/** The expense list's views, in tab order. */
export const EXPENSE_LIST_VIEWS = [
  "all",
  "awaiting_me",
  "assign_ownership",
  "resolve_ownership",
  "owner_approval",
  "owner_exception",
  "capital_review",
  "set_depreciation_cycle",
  "qb_pending",
] as const;
export type ExpenseListView = (typeof EXPENSE_LIST_VIEWS)[number];

/** The roles the services check before an act on an expense. */
export interface ExpenseViewer {
  /** An owner or treasurer of at least one bucket. */
  approver: boolean;
  isFinance: boolean;
  isBoard: boolean;
}

/**
 * Who can act in each view, by the checks the view's acts run: approving admits a bucket approver
 * or a Board member (approvalRefusal), raising an exception a bucket approver or FINANCE; bucket
 * assignment, exceptions, capital review and depreciation are FINANCE only (requireFinance); in QB
 * pending FINANCE names the reimbursee and FINANCE or the Board records the Board authorization.
 * All lists whatever the viewer may open.
 */
const VIEW_ACTORS: Record<ExpenseListView, (v: ExpenseViewer) => boolean> = {
  all: () => true,
  awaiting_me: (v) => v.approver || v.isBoard,
  assign_ownership: (v) => v.isFinance,
  resolve_ownership: (v) => v.isFinance,
  owner_approval: (v) => v.approver || v.isBoard || v.isFinance,
  owner_exception: (v) => v.isFinance,
  capital_review: (v) => v.isFinance,
  set_depreciation_cycle: (v) => v.isFinance,
  qb_pending: (v) => v.isFinance || v.isBoard,
};

/** The views the viewer can act in, in tab order; the routes refuse the others. */
export function expenseViewsFor(viewer: ExpenseViewer): ExpenseListView[] {
  return EXPENSE_LIST_VIEWS.filter((view) => VIEW_ACTORS[view](viewer));
}

export interface ExpenseNavLink {
  name: string;
  href: string;
  /** Emoji icon (the host's SectionTabs render an emoji string). */
  icon: string;
}

export const EXPENSE_TABS = {
  settings: { name: "Finance", href: "/settings/finance", icon: "⚙️" },
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
    { name: "Donated Equipment", href: "/expense/donated-capital", icon: "🎁" },
  ],
} as const satisfies { expenses: ExpenseNavLink; setup: readonly ExpenseNavLink[] };
