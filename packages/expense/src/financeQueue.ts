import type { QueueTab, ReasonCode } from "./lib/reasons";

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

/** The tab an expense-page reason sits in, keyed by its `?queue=` value. */
export const TAB_OF_QUEUE: Record<QueueTab, FinanceQueueTabKey> = { expenses: "expenses", holds: "accountHolds", qb: "quickbooks", board: "board" };

/**
 * The finance queue's reason codes: every expense-page reason (lib/reasons.ts), a failed intake,
 * and the signatures the viewer may give.
 */
export type FinanceQueueReasonCode = ReasonCode | "INTAKE_FAILED" | "TREASURER_SIGNATURE" | "BOARD_SIGNATURE";

/** Each reason's chip label, in the order a tab's list sorts by. */
export const FINANCE_QUEUE_REASONS: Record<FinanceQueueReasonCode, string> = {
  BUCKET_TO_ASSIGN: "Bucket to assign",
  BUCKET_UNKNOWN: "Bucket unknown",
  OWNER_EXCEPTION: "Exception raised by a budget owner",
  CAPITAL_REVIEW: "Capital review",
  DEPRECIATION_CYCLE: "Depreciation cycle",
  REIMBURSEE_TO_NAME: "Reimbursee to name",
  TAX_NOT_REVIEWED: "Tax not reviewed",
  INTAKE_FAILED: "Receipt didn't become an expense",
  TREASURER_SIGNATURE: "Treasurer signature",
  ACCOUNT_HOLD: "No account rule",
  QB_POST_FAILED: "Posting failed",
  QB_DUPLICATE_TO_VOID: "Duplicate to void",
  QB_DRIFT: "Changed in QuickBooks",
  QB_POST_HELD: "Closed but not posted",
  QB_NO_CLASS: "No QuickBooks class",
  QB_AWAITING_MATCH: "Waiting for a match",
  QB_VENDOR_MISSING: "No QuickBooks vendor",
  BOARD_APPROVAL: "Board approval not recorded",
  SIGNER_HELD: "Held, no conflict-free signer",
  BOARD_SIGNATURE: "Board signature to give",
};

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
