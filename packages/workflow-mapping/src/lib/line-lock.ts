import { EDITABLE_RECEIPT_STATES } from "../db/schema";

export const APPLIED_LINES_LOCKED = "Part of this receipt was already applied, so its lines are locked.";

type LockFields = {
  state: string;
  inventoryAppliedAt: Date | string | null;
  expenseAppliedAt: Date | string | null;
  donationAppliedAt: Date | string | null;
};

/** Why a receipt's lines can't be edited, or null while they can. */
export function lineLockReason(received: LockFields): string | null {
  if (!EDITABLE_RECEIPT_STATES.some((s) => s === received.state)) {
    return `Cannot edit lines of a receipt in state "${received.state}"`;
  }
  if (received.inventoryAppliedAt || received.expenseAppliedAt || received.donationAppliedAt) return APPLIED_LINES_LOCKED;
  return null;
}
