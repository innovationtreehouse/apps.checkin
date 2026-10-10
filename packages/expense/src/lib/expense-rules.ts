import type { ExpenseOrgSettings, ExpenseLineItem } from "../db/schema";

// ── Approval terminal states ──────────────────────────────────────────────────

export const TERMINAL_APPROVAL_STATUSES = new Set(["approved", "finance_assigned", "rejected"] as const);
export type TerminalApprovalStatus = "approved" | "finance_assigned" | "rejected";

export function isTerminalApproval(status: string): status is TerminalApprovalStatus {
  return TERMINAL_APPROVAL_STATUSES.has(status as TerminalApprovalStatus);
}

/** True when any approval is the terminal, non-proceeding `rejected` status. One rejected line refuses the whole expense. */
export function anyRejected(approvals: { status: string }[]): boolean {
  return approvals.some((a) => a.status === "rejected");
}

// ── Capital classification ────────────────────────────────────────────────────

/**
 * Determines whether an expense qualifies for capital review based on org thresholds.
 * Returns false when org settings are unavailable (treat as non-capital).
 */
export function classifyCapital(
  receiptTotalCents: number,
  lineItems: Pick<ExpenseLineItem, "unitPriceCents">[],
  org: Pick<ExpenseOrgSettings, "capitalTotalThresholdCents" | "capitalLineItemThresholdCents"> | null | undefined,
): boolean {
  if (!org) return false;
  return (
    receiptTotalCents > org.capitalTotalThresholdCents ||
    lineItems.some((li) => li.unitPriceCents > org.capitalLineItemThresholdCents)
  );
}

// ── Hold reasons ──────────────────────────────────────────────────────────────

export const HoldReason = {
  NO_MATCH:         "NO_MATCH",
  MULTIPLE_MATCHES: "MULTIPLE_MATCHES",
  NO_PART_NUMBER:   "NO_PART_NUMBER",
} as const;

export type HoldReason = (typeof HoldReason)[keyof typeof HoldReason];

export const HOLD_REASON_VALUES = Object.values(HoldReason) as HoldReason[];
