import { httpError } from "@checkin/component-kit";
import { db } from "../db";
import { EDITABLE_RECEIPT_STATES, EDITABLE_RECEIPT_WHERE, type ReceivedReceipt, type ReceivedReceiptLineStatusRow } from "../db/schema";
import { insertAuditEvent } from "../lib/audit";
import { parseStoredReceipt } from "../lib/parse-receipt";
import { getOrg, type Actor } from "../runtime";

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

/** Lines are edited only while their receipt is pending_review or apply_failed. */
export function assertEditable(received: Pick<ReceivedReceipt, "state">): void {
  if (!EDITABLE_RECEIPT_STATES.some((s) => s === received.state)) {
    throw httpError(409, `Cannot edit lines of a receipt in state "${received.state}"`);
  }
}

export type AppliedLeg = "inventory" | "expense" | "donation";
type LegStamps = Pick<ReceivedReceipt, "inventoryAppliedAt" | "expenseAppliedAt" | "donationAppliedAt">;

/** The downstream legs already applied, which a line edit can no longer reach. */
export function appliedLegs(received: LegStamps): AppliedLeg[] {
  const legs: AppliedLeg[] = [];
  if (received.inventoryAppliedAt) legs.push("inventory");
  if (received.expenseAppliedAt) legs.push("expense");
  if (received.donationAppliedAt) legs.push("donation");
  return legs;
}

type LineDecision = Pick<ReceivedReceiptLineStatusRow,
  "recognitionStatus" | "assignedGtin13" | "provisionalItemGtin13" | "conversionFactor" | "conversionVersion">;

const decisionOf = (ls: LineDecision): LineDecision => ({
  recognitionStatus: ls.recognitionStatus,
  assignedGtin13: ls.assignedGtin13,
  provisionalItemGtin13: ls.provisionalItemGtin13,
  conversionFactor: ls.conversionFactor,
  conversionVersion: ls.conversionVersion,
});

/**
 * Log an edit made after some leg applied: that leg keeps the old lines (a retry never re-sends
 * it), so the row names the legs needing a manual fix and what changed.
 */
export async function auditLateEdit(
  received: LegStamps & Pick<ReceivedReceipt, "id" | "orgId">,
  before: LineDecision & { id: number },
  data: Partial<LineDecision>,
  actor: { actorUserId: number | null; actorUsername?: string | null },
): Promise<void> {
  const legs = appliedLegs(received);
  if (legs.length === 0) return;
  await insertAuditEvent(db, {
    orgId: received.orgId,
    ...actor,
    eventType: "line_edited_late",
    receivedReceiptId: received.id,
    lineStatusId: before.id,
    details: JSON.stringify({ appliedLegs: legs, before: decisionOf(before), after: decisionOf({ ...before, ...data }) }),
  });
}

/**
 * Write a line decision only if its receipt is still editable at write time, so a concurrent
 * proceed cannot be followed by an edit to what was pushed. An edit after a leg applied is
 * logged as late.
 */
export async function updateEditableLine(
  edit: { received: ReceivedReceipt; lineStatus: ReceivedReceiptLineStatusRow },
  data: Partial<LineDecision>,
  actor: Actor,
): Promise<void> {
  const { count } = await db.receivedReceiptLineStatus.updateMany({
    where: { id: edit.lineStatus.id, receivedReceipt: EDITABLE_RECEIPT_WHERE },
    data,
  });
  if (count !== 1) throw httpError(409, "Receipt is no longer editable");
  await auditLateEdit(edit.received, edit.lineStatus, data, { actorUserId: actor.id, actorUsername: actor.name });
}
