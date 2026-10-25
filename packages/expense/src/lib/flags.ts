// GC-FIN-CONTROL flags: surfaced to a human for checkoff, never enforced.
import type { ExpenseSettings } from "../contract";
import { reimburseeUnknown } from "./signoff";

export const FLAG_KINDS = ["TAX_ATTACHED", "THRESHOLD_CROSSED", "COI", "REIMBURSEE_UNKNOWN", "QB_POST_FAILED", "QB_OVER_CAP", "QB_DRIFT", "QB_NO_CLASS", "QB_POST_HELD"] as const;
export type FlagKind = (typeof FLAG_KINDS)[number];
export type FlagAudience = "FINANCE" | "BOARD";

/** Threshold and conflict flags escalate to the board; the rest are finance's. */
export const FLAG_AUDIENCE: Record<FlagKind, FlagAudience> = {
  TAX_ATTACHED: "FINANCE",
  THRESHOLD_CROSSED: "BOARD",
  COI: "BOARD",
  REIMBURSEE_UNKNOWN: "FINANCE",
  QB_POST_FAILED: "FINANCE",
  QB_OVER_CAP: "FINANCE",
  QB_DRIFT: "FINANCE",
  QB_NO_CLASS: "FINANCE",
  QB_POST_HELD: "FINANCE",
};

/** Flags that stay open while the hold they signal applies, with why a check-off is refused. */
export const HOLD_FLAGS: ReadonlyMap<string, string> = new Map<FlagKind, string>([
  ["REIMBURSEE_UNKNOWN", "Set the reimbursee to clear this flag"],
]);

/** What the duplicate path writes into a QB_POST_FAILED flag's detail when the entry it posted needs voiding. */
export const NEEDS_VOIDING = "needs voiding";

/** The three questions finance decides as a review, each with a required note. */
export const REVIEW_KINDS = ["QB_DUPLICATE_TO_VOID", "QB_DRIFT", "QB_POST_HELD"] as const;
export type ReviewKind = (typeof REVIEW_KINDS)[number];

/** The review a flag row asks for, or null when it is not one; a duplicate to void is still raised as QB_POST_FAILED. */
export function reviewKindOf(flag: { kind: string; detail: string | null }): ReviewKind | null {
  if (flag.kind === "QB_POST_FAILED") return flag.detail?.includes(NEEDS_VOIDING) ? "QB_DUPLICATE_TO_VOID" : null;
  return (REVIEW_KINDS as readonly string[]).includes(flag.kind) ? (flag.kind as ReviewKind) : null;
}

/** The expense's stored receipt review (ExpenseReceiptReview), or null when the receipt sent none. */
export interface StoredReceiptReview {
  taxReviewRequired: boolean | null;
  reasons: readonly string[];
  approvedTaxCents: number | null;
}

/**
 * Tax waits on finance when the receipt org's settings hold it for review and no receipt finance
 * approval covers that amount. A receipt that did not say whether review applies is held.
 */
export function taxNeedsFinance(taxCents: number, review: StoredReceiptReview | null): boolean {
  if (taxCents <= 0 || review?.taxReviewRequired === false) return false;
  return !(review?.reasons.includes("tax") && review.approvedTaxCents === taxCents);
}

/** Flags derivable from the expense and the org's thresholds, raised at intake. */
export function detectIntakeFlags(
  expense: {
    taxCents: number;
    receiptReview?: StoredReceiptReview | null;
    receiptTotalCents: number;
    lineItems: { unitPriceCents: number; totalPriceCents: number }[];
    needsReimbursement?: boolean;
    backfill?: boolean;
    reimburseePersonId?: number | null;
  },
  settings: Pick<ExpenseSettings, "boardReviewTotalCents">,
): FlagKind[] {
  const flags: FlagKind[] = [];
  if (taxNeedsFinance(expense.taxCents, expense.receiptReview ?? null)) flags.push("TAX_ATTACHED");
  // The Board-review total is the receipt's total, never a single line's.
  if (expense.receiptTotalCents >= settings.boardReviewTotalCents) flags.push("THRESHOLD_CROSSED");
  if (reimburseeUnknown({ needsReimbursement: expense.needsReimbursement ?? false, backfill: expense.backfill ?? false, reimburseePersonId: expense.reimburseePersonId ?? null })) {
    flags.push("REIMBURSEE_UNKNOWN");
  }
  return flags;
}
