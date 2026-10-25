import { EDITABLE_RECEIPT_STATES } from "../db/schema";

/** Why a receipt's lines can't be edited, or null while they can. */
export function lineLockReason(received: { state: string }): string | null {
  if (!EDITABLE_RECEIPT_STATES.some((s) => s === received.state)) {
    return `Cannot edit lines of a receipt in state "${received.state}"`;
  }
  return null;
}
