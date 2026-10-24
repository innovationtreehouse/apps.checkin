// GC-FIN-CONTROL flags: surfaced to a human for checkoff, never enforced.
import type { ExpenseSettings } from "../contract";
import { reimburseeUnknown } from "./signoff";

export const FLAG_KINDS = ["TAX_ATTACHED", "THRESHOLD_CROSSED", "CAPITAL_EQUIPMENT", "MISSING_RECEIPT", "NON_EVERYDAY", "COI", "REIMBURSEE_UNKNOWN", "QB_POST_FAILED", "QB_OVER_CAP", "QB_DRIFT", "QB_NO_CLASS", "QB_POST_HELD"] as const;
export type FlagKind = (typeof FLAG_KINDS)[number];
export type FlagAudience = "FINANCE" | "BOARD";

/** Threshold and conflict flags escalate to the board; the rest are finance's. */
export const FLAG_AUDIENCE: Record<FlagKind, FlagAudience> = {
  TAX_ATTACHED: "FINANCE",
  THRESHOLD_CROSSED: "BOARD",
  CAPITAL_EQUIPMENT: "FINANCE",
  MISSING_RECEIPT: "FINANCE",
  NON_EVERYDAY: "FINANCE",
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

/**
 * Flags derivable from the expense and the org's thresholds, raised at intake. MISSING_RECEIPT
 * and NON_EVERYDAY are raised by hand.
 */
export function detectIntakeFlags(
  expense: {
    taxCents: number;
    receiptTotalCents: number;
    lineItems: { unitPriceCents: number; totalPriceCents: number }[];
    needsReimbursement?: boolean;
    backfill?: boolean;
    reimburseePersonId?: number | null;
  },
  settings: Pick<ExpenseSettings, "boardReviewTotalCents" | "capitalEquipmentUnitCents">,
): FlagKind[] {
  const flags: FlagKind[] = [];
  if (expense.taxCents > 0) flags.push("TAX_ATTACHED");
  // The Board-review total is the receipt's total, never a single line's.
  if (expense.receiptTotalCents >= settings.boardReviewTotalCents) flags.push("THRESHOLD_CROSSED");
  if (expense.lineItems.some((li) => li.unitPriceCents >= settings.capitalEquipmentUnitCents)) flags.push("CAPITAL_EQUIPMENT");
  if (reimburseeUnknown({ needsReimbursement: expense.needsReimbursement ?? false, backfill: expense.backfill ?? false, reimburseePersonId: expense.reimburseePersonId ?? null })) {
    flags.push("REIMBURSEE_UNKNOWN");
  }
  return flags;
}
