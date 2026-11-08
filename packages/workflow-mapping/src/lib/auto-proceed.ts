import { db } from "../db";
import type { ReceivedReceipt, ReceivedReceiptState } from "../db/schema";
import type { Actor } from "../runtime";
import {
  assertWorkflowMappingTransition,
  isWorkflowMappingTransitionLegal,
  areAllLinesResolved,
} from "../workflows/workflow-mapping.machine";
import { executePushAndSettle } from "./apply-receipt";
import { insertAuditEvent } from "./audit";

/** Sends the receipt to apply once every line is decided. A null actor is the system, such as the matching re-run. */
export async function tryAutoProceedApply(
  receiptId: number,
  received: Pick<ReceivedReceipt, "id" | "orgId" | "state" | "receiptJson">,
  actor: Actor | null,
): Promise<void> {
  if (!isWorkflowMappingTransitionLegal(received.state as ReceivedReceiptState, "PROCEED")) return;

  const lineStatuses = await db.receivedReceiptLineStatus.findMany({
    where: { receivedReceiptId: receiptId },
  });

  if (!areAllLinesResolved(lineStatuses)) return;

  const nextState = assertWorkflowMappingTransition(received.state as ReceivedReceiptState, "PROCEED");

  // Compare-and-set: of concurrent callers that saw the last line resolve, only one pushes.
  const { count } = await db.receivedReceipt.updateMany({
    where: { id: receiptId, state: received.state },
    data: { state: nextState, matchingPendingSince: null },
  });
  if (count !== 1) return;

  await insertAuditEvent(db, {
    orgId: received.orgId,
    actorUserId: actor?.id ?? null,
    actorUsername: actor?.name ?? null,
    eventType: "auto_proceed_triggered",
    receivedReceiptId: receiptId,
    fromState: received.state,
    toState: nextState,
  });

  await executePushAndSettle(receiptId, received, actor?.id ?? null, actor?.name ?? null);
}
