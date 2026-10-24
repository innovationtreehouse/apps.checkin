/**
 * The finance queue's expense tabs (#2481 §3): their keys, the `?queue=` value each rides under on
 * the host's Finance review screen, and the reasons each holds. Shared by the service and the
 * screen, so it imports nothing server-side.
 */

export const FINANCE_QUEUE_TABS = [
  { key: "expenses", queue: "expenses", label: "Expenses" },
  { key: "toSign", queue: "to_sign", label: "To sign" },
  { key: "accountHolds", queue: "holds", label: "Account holds" },
  { key: "quickbooks", queue: "qb", label: "QuickBooks" },
  { key: "board", queue: "board", label: "Board" },
] as const;

export type FinanceQueueTabKey = (typeof FINANCE_QUEUE_TABS)[number]["key"];

/** Each reason, in the order a tab's list sorts by, with its chip label. */
export const FINANCE_QUEUE_REASONS = {
  bucket_to_assign: { tab: "expenses", label: "Bucket to assign" },
  bucket_unknown: { tab: "expenses", label: "Bucket unknown" },
  owner_exception: { tab: "expenses", label: "Exception raised by a budget owner" },
  capital_review: { tab: "expenses", label: "Capital review" },
  depreciation_cycle: { tab: "expenses", label: "Depreciation cycle" },
  reimbursee_to_name: { tab: "expenses", label: "Reimbursee to name" },
  tax_not_reviewed: { tab: "expenses", label: "Tax not reviewed on the receipt" },
  intake_failed: { tab: "expenses", label: "Receipt didn't become an expense" },
  treasurer_signature: { tab: "toSign", label: "Treasurer signature" },
  account_hold: { tab: "accountHolds", label: "No account rule" },
  qb_post_failed: { tab: "quickbooks", label: "Posting failed" },
  qb_duplicate_to_void: { tab: "quickbooks", label: "Duplicate entry in QuickBooks needs voiding" },
  qb_drift: { tab: "quickbooks", label: "Changed in QuickBooks after posting" },
  qb_post_held: { tab: "quickbooks", label: "Closed but not posted" },
  qb_no_class: { tab: "quickbooks", label: "Bucket has no QuickBooks class" },
  qb_ambiguous: { tab: "quickbooks", label: "Waiting for a match" },
  board_approval_not_recorded: { tab: "board", label: "Board approval not recorded" },
  board_held: { tab: "board", label: "No Board member without a conflict can sign; held" },
  board_signature: { tab: "board", label: "Board signature to give" },
} as const satisfies Record<string, { tab: FinanceQueueTabKey; label: string }>;

export type FinanceQueueReasonCode = keyof typeof FINANCE_QUEUE_REASONS;

/** One reason on a row: its code, the plain-word line, and where to act when that isn't the expense page. */
export interface FinanceQueueReason {
  code: FinanceQueueReasonCode;
  text: string;
  href?: string;
}

/** GET /api/expense/finance-queue?tab=…: one record waiting on finance or the Board. A failed intake has no expense. */
export interface FinanceQueueRow {
  expenseId: string | null;
  vendorName: string | null;
  date: string | null;
  amountCents: number;
  currency: string;
  reasons: FinanceQueueReason[];
  waitingSince: string;
}

export interface FinanceQueueTabCount {
  actionable: number;
  total: number;
  /** The actionable units per reason, for the chips. */
  byReason: Partial<Record<FinanceQueueReasonCode, number>>;
}

export type FinanceQueueCounts = Record<FinanceQueueTabKey, FinanceQueueTabCount>;

export const financeQueueTab = (queue: string | null) => FINANCE_QUEUE_TABS.find((t) => t.queue === queue) ?? null;
