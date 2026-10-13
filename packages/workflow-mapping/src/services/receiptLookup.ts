import { db } from "../db";
import { EDITABLE_RECEIPT_STATES, EDITABLE_RECEIPT_WHERE, type ReceivedReceipt, type ReceivedReceiptLineStatusRow } from "../db/schema";
import { parseStoredReceipt } from "../lib/parse-receipt";
import { getOrg, httpError } from "../runtime";

/** The org's receipt by id, or 404. */
export async function loadReceipt(receiptId: number): Promise<ReceivedReceipt> {
  const received = await db.receivedReceipt.findUnique({ where: { id: receiptId } });
  if (!received || received.orgId !== (await getOrg()).id) throw httpError(404, "Not found");
  return received;
}

/** A line of an editable receipt with its receipt-line item, or 404 / 409 / 422. */
export async function loadEditableLine(receiptId: number, lineId: number) {
  const received = await loadReceipt(receiptId);
  assertEditable(received);

  const lineStatus = await db.receivedReceiptLineStatus.findUnique({ where: { id: lineId } });
  if (!lineStatus || lineStatus.receivedReceiptId !== receiptId) throw httpError(404, "Line not found");

  const parsed = parseStoredReceipt(received.receiptJson);
  if (!parsed.ok) throw httpError(422, parsed.error);
  const lineItem = parsed.receipt.lineItems.find((li) => li.receiptLineItemId === lineStatus.receiptLineItemId);
  if (!lineItem) throw httpError(404, "Line item not found in receipt");

  return { received, lineStatus, receipt: parsed.receipt, lineItem };
}

/**
 * Lines are edited only while their receipt is pending_review or apply_failed and no downstream
 * leg has applied, so every leg is pushed the same lines.
 */
export function assertEditable(
  received: Pick<ReceivedReceipt, "state" | "inventoryAppliedAt" | "expenseAppliedAt" | "donationAppliedAt">,
): void {
  if (!EDITABLE_RECEIPT_STATES.some((s) => s === received.state)) {
    throw httpError(409, `Cannot edit lines of a receipt in state "${received.state}"`);
  }
  if (received.inventoryAppliedAt || received.expenseAppliedAt || received.donationAppliedAt) {
    throw httpError(409, "Cannot edit lines once a downstream leg has applied");
  }
}

/**
 * Write a line decision only if its receipt is still editable at write time, so a concurrent
 * proceed cannot be followed by an edit to what was pushed.
 */
export async function updateEditableLine(
  lineId: number,
  data: Partial<Pick<ReceivedReceiptLineStatusRow,
    "recognitionStatus" | "assignedGtin13" | "provisionalItemGtin13" | "conversionFactor" | "conversionVersion">>,
): Promise<void> {
  const { count } = await db.receivedReceiptLineStatus.updateMany({
    where: { id: lineId, receivedReceipt: EDITABLE_RECEIPT_WHERE },
    data,
  });
  if (count !== 1) throw httpError(409, "Receipt is no longer editable");
}
