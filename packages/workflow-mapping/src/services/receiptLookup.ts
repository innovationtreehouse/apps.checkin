import { httpError } from "@checkin/component-kit";
import { db } from "../db";
import { EDITABLE_RECEIPT_WHERE, type NewWorkflowAuditEvent, type ReceivedReceipt, type ReceivedReceiptLineStatusRow } from "../db/schema";
import { insertAuditEvent } from "../lib/audit";
import { lineLockReason } from "../lib/line-lock";
import { parseStoredReceipt } from "../lib/parse-receipt";
import { getOrg } from "../runtime";

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

/** Lines are edited only in pending_review. */
export function assertEditable(received: Pick<ReceivedReceipt, "state">): void {
  const reason = lineLockReason(received);
  if (reason) throw httpError(409, reason);
}

type LineDecision = Pick<ReceivedReceiptLineStatusRow,
  "recognitionStatus" | "assignedGtin13" | "provisionalItemGtin13" | "conversionFactor" | "conversionVersion">;

/**
 * Write a line decision only if its receipt is still editable at write time, so a concurrent
 * proceed or apply cannot be followed by an edit to what was pushed. The audit row commits with
 * the decision, so no edit lands unlogged.
 */
export async function updateEditableLine(
  edit: { received: ReceivedReceipt; lineStatus: ReceivedReceiptLineStatusRow },
  data: Partial<LineDecision>,
  event: NewWorkflowAuditEvent,
): Promise<void> {
  await db.$transaction(async (tx) => {
    const { count } = await tx.receivedReceiptLineStatus.updateMany({
      where: { id: edit.lineStatus.id, receivedReceipt: EDITABLE_RECEIPT_WHERE },
      data,
    });
    if (count !== 1) throw httpError(409, "Receipt is no longer editable");
    await insertAuditEvent(tx, event);
  });
}
