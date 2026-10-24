// Finance reviews: a judgment with nothing else to record it, decided on the expense with a note.
export const FLAG_KINDS = ["QB_DUPLICATE_TO_VOID", "QB_DRIFT", "QB_POST_HELD"] as const;
export type FlagKind = (typeof FLAG_KINDS)[number];
export type FlagAudience = "FINANCE" | "BOARD";

/** Kinds nothing raises any more; the queue reads their conditions from the expense. */
export const RETIRED_FLAG_KINDS = [
  "TAX_ATTACHED",
  "THRESHOLD_CROSSED",
  "CAPITAL_EQUIPMENT",
  "MISSING_RECEIPT",
  "NON_EVERYDAY",
  "COI",
  "REIMBURSEE_UNKNOWN",
  "QB_POST_FAILED",
  "QB_OVER_CAP",
  "QB_NO_CLASS",
] as const;

export const FLAG_AUDIENCE: Record<FlagKind, FlagAudience> = {
  QB_DUPLICATE_TO_VOID: "FINANCE",
  QB_DRIFT: "FINANCE",
  QB_POST_HELD: "FINANCE",
};

export function isFlagKind(kind: string): kind is FlagKind {
  return (FLAG_KINDS as readonly string[]).includes(kind);
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
