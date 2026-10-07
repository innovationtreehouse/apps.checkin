// GC-FIN-CONTROL flags: surfaced to a human for checkoff, never enforced.
import type { ExpenseSettings } from "../contract";
import { reimburseeUnknown } from "./signoff";

export const FLAG_KINDS = ["TAX_ATTACHED", "THRESHOLD_CROSSED", "CAPITAL_EQUIPMENT", "MISSING_RECEIPT", "NON_EVERYDAY", "COI", "REIMBURSEE_UNKNOWN"] as const;
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
};

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
  if (
    expense.receiptTotalCents >= settings.boardReviewTotalCents ||
    expense.lineItems.some((li) => li.totalPriceCents >= settings.boardReviewTotalCents)
  ) {
    flags.push("THRESHOLD_CROSSED");
  }
  if (expense.lineItems.some((li) => li.unitPriceCents >= settings.capitalEquipmentUnitCents)) flags.push("CAPITAL_EQUIPMENT");
  if (reimburseeUnknown({ needsReimbursement: expense.needsReimbursement ?? false, backfill: expense.backfill ?? false, reimburseePersonId: expense.reimburseePersonId ?? null })) {
    flags.push("REIMBURSEE_UNKNOWN");
  }
  return flags;
}
