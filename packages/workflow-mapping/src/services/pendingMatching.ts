import { KindedError, NotWiredError } from "@checkin/component-kit";
import type { CompletedReceiptLineItem } from "@checkin/receipt-types";
import { db } from "../db";
import { EDITABLE_RECEIPT_WHERE, type ReceivedReceipt } from "../db/schema";
import { tryAutoProceedApply } from "../lib/auto-proceed";
import { insertAuditEvent } from "../lib/audit";
import { parseStoredReceipt } from "../lib/parse-receipt";
import type { Actor } from "../runtime";
import { matchLines, type Matching } from "./receiptIntakeService";

type PendingRow = Pick<ReceivedReceipt, "id" | "orgId" | "receiptId" | "state" | "receiptJson" | "matchingPendingSince">;

/** Matching on the lines nobody has decided yet. An unbound catalog, a settings failure or a bug counts as not run. */
async function matchUndecided(row: PendingRow): Promise<{ matching: Matching; lineIds: Map<number, number> }> {
  const lines = await db.receivedReceiptLineStatus.findMany({
    where: { receivedReceiptId: row.id, recognitionStatus: "unrecognized" },
    select: { id: true, receiptLineItemId: true },
  });
  const lineIds = new Map(lines.map((l) => [l.receiptLineItemId, l.id]));
  const parsed = parseStoredReceipt(row.receiptJson);
  if (!parsed.ok) return { matching: { ran: false, err: new KindedError("data", parsed.error) }, lineIds };
  const undecided: CompletedReceiptLineItem[] = parsed.receipt.lineItems.filter((li) => lineIds.has(li.receiptLineItemId));
  try {
    const matching = await matchLines(undecided, parsed.receipt.vendorName);
    if (matching.ran && matching.note) return { matching: { ran: false, err: new NotWiredError("CatalogReader.lookupItems") }, lineIds };
    return { matching, lineIds };
  } catch (err) {
    return { matching: { ran: false, err }, lineIds };
  }
}

/**
 * A person runs matching for one receipt still waiting for mapping. Each match is written only
 * while the line is unrecognized and the receipt waits for mapping, so a person's decision always
 * stands. When matching ran the flag clears and the receipt does what arrival would have: every
 * line decided sends it. When it could not run, the receipt stays pending, unchanged.
 */
export async function rerunMatching(row: PendingRow, actor: Actor): Promise<"ran" | "deferred"> {
  const { matching, lineIds } = await matchUndecided(row);
  if (!matching.ran) return "deferred";

  let matched = 0;
  for (const [receiptLineItemId, resolved] of matching.recognized) {
    const lineStatusId = lineIds.get(receiptLineItemId);
    if (lineStatusId === undefined) continue;
    const { count } = await db.receivedReceiptLineStatus.updateMany({
      where: { id: lineStatusId, recognitionStatus: "unrecognized", receivedReceipt: EDITABLE_RECEIPT_WHERE },
      data: {
        recognitionStatus: "recognized",
        assignedGtin13: resolved.gtin13,
        conversionFactor: resolved.conversionFactor,
        conversionVersion: resolved.conversionVersion,
      },
    });
    if (count === 0) continue;
    matched++;
    await insertAuditEvent(db, {
      orgId: row.orgId,
      actorUserId: actor.id,
      actorUsername: actor.name,
      eventType: "line_matched",
      receivedReceiptId: row.id,
      lineStatusId,
      details: JSON.stringify({ gtin13: resolved.gtin13 }),
    });
  }

  await db.receivedReceipt.updateMany({ where: { id: row.id }, data: { matchingPendingSince: null } });
  await insertAuditEvent(db, {
    orgId: row.orgId,
    actorUserId: actor.id,
    actorUsername: actor.name,
    eventType: "matching_ran",
    receivedReceiptId: row.id,
    details: JSON.stringify({ matched }),
  });
  await tryAutoProceedApply(row.id, row, actor);
  return "ran";
}
