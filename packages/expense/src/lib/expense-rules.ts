import type { ExpenseSettings } from "../contract";

// ── Approval terminal states ──────────────────────────────────────────────────

// A finance-assigned line waits for its new bucket's approver, so it is not terminal.
export const TERMINAL_APPROVAL_STATUSES = new Set(["approved", "rejected"] as const);
export type TerminalApprovalStatus = "approved" | "rejected";

export function isTerminalApproval(status: string): status is TerminalApprovalStatus {
  return TERMINAL_APPROVAL_STATUSES.has(status as TerminalApprovalStatus);
}

/** True when any approval is the terminal, non-proceeding `rejected` status. One rejected line refuses the whole expense. */
export function anyRejected(approvals: { status: string }[]): boolean {
  return approvals.some((a) => a.status === "rejected");
}

// ── Capital classification ────────────────────────────────────────────────────

export type CapitalSettings = Pick<ExpenseSettings, "capitalReviewEnabled" | "capitalTotalThresholdCents" | "capitalLineItemThresholdCents">;

/** Capital review is on but a threshold is unset, so every expense and donated line waits at review. */
export function capitalThresholdsUnset(s: CapitalSettings): boolean {
  return s.capitalReviewEnabled && (s.capitalTotalThresholdCents === null || s.capitalLineItemThresholdCents === null);
}

/**
 * Whether a record goes to capital review: never while review is off, always while a threshold is
 * unset, and otherwise when its total or a unit's cost is at or over its threshold. A unit's cost
 * is its share of what its line books at.
 */
export function classifyCapital(totalCents: number, unitCostCents: number[], s: CapitalSettings): boolean {
  if (!s.capitalReviewEnabled) return false;
  if (s.capitalTotalThresholdCents === null || s.capitalLineItemThresholdCents === null) return true;
  const { capitalTotalThresholdCents: total, capitalLineItemThresholdCents: unit } = s;
  return totalCents >= total || unitCostCents.some((c) => c >= unit);
}

// ── Hold reasons ──────────────────────────────────────────────────────────────

export const HoldReason = {
  NO_MATCH:         "NO_MATCH",
  MULTIPLE_MATCHES: "MULTIPLE_MATCHES",
  NO_PART_NUMBER:   "NO_PART_NUMBER",
  NON_INVENTORY:    "NON_INVENTORY",
} as const;

export type HoldReason = (typeof HoldReason)[keyof typeof HoldReason];

export const HOLD_REASON_VALUES = Object.values(HoldReason) as HoldReason[];
