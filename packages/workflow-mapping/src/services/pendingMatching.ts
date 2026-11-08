import { KindedError, NotWiredError, kindOf } from "@checkin/component-kit";
import type { CompletedReceiptLineItem } from "@checkin/receipt-types";
import { db } from "../db";
import { EDITABLE_RECEIPT_WHERE, type ReceivedReceipt } from "../db/schema";
import { tryAutoProceedApply } from "../lib/auto-proceed";
import { insertAuditEvent } from "../lib/audit";
import { parseStoredReceipt } from "../lib/parse-receipt";
import { getOrgId, workflowRuntime } from "../runtime";
import { matchLines, type Matching } from "./receiptIntakeService";

/** Days the daily re-run keeps trying a receipt whose matching couldn't run, before it gives up. */
export const MATCHING_RETRY_DAYS = 5;

/** Most receipts one run re-matches; the rest wait for the next run. */
export const PENDING_MATCHING_CAP = 50;

const DAY_MS = 24 * 60 * 60 * 1000;

type PendingRow = Pick<ReceivedReceipt, "id" | "orgId" | "receiptId" | "state" | "receiptJson" | "matchingPendingSince">;

type Outcome = "ran" | "deferred" | "gaveUp" | "errored";

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
 * Re-runs matching for one receipt still waiting for mapping. Each match is written only while
 * the line is unrecognized and the receipt waits for mapping, so a person's decision always
 * stands. When matching ran the flag clears and the receipt does what arrival would have: every
 * line decided sends it. Past MATCHING_RETRY_DAYS the flag clears, the lines stay for hand
 * mapping, and the failure goes to the on-failure port once.
 */
async function rerunMatching(row: PendingRow): Promise<Outcome> {
  const { matching, lineIds } = await matchUndecided(row);
  const since = row.matchingPendingSince;

  if (!matching.ran) {
    if (!since || Date.now() - since.getTime() < MATCHING_RETRY_DAYS * DAY_MS) {
      const kind = kindOf(matching.err);
      return kind === "system" || kind === "connection" ? "deferred" : "errored";
    }
    const { count } = await db.receivedReceipt.updateMany({
      where: { id: row.id, matchingPendingSince: since },
      data: { matchingPendingSince: null },
    });
    if (count !== 1) return "deferred";
    await insertAuditEvent(db, {
      orgId: row.orgId,
      actorUserId: null,
      eventType: "matching_gave_up",
      receivedReceiptId: row.id,
      details: JSON.stringify({ retryDays: MATCHING_RETRY_DAYS }),
    });
    workflowRuntime.failed("matching", matching.err, `receipt ${row.receiptId}`);
    return "gaveUp";
  }

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
      actorUserId: null,
      eventType: "line_matched",
      receivedReceiptId: row.id,
      lineStatusId,
      details: JSON.stringify({ gtin13: resolved.gtin13 }),
    });
  }

  await db.receivedReceipt.updateMany({ where: { id: row.id }, data: { matchingPendingSince: null } });
  await insertAuditEvent(db, {
    orgId: row.orgId,
    actorUserId: null,
    eventType: "matching_ran",
    receivedReceiptId: row.id,
    details: JSON.stringify({ matched }),
  });
  await tryAutoProceedApply(row.id, row, null);
  return "ran";
}

/**
 * Daily step: re-runs matching on receipts whose matching couldn't run on arrival and that still
 * wait for mapping, oldest first, up to the cap. One receipt's database error does not stop the
 * rest. Returns counts only.
 */
export async function retryPendingMatching(): Promise<Record<Outcome, number>> {
  const rows = await db.receivedReceipt.findMany({
    where: { orgId: await getOrgId(), ...EDITABLE_RECEIPT_WHERE, matchingPendingSince: { not: null } },
    select: { id: true, orgId: true, receiptId: true, state: true, receiptJson: true, matchingPendingSince: true },
    orderBy: { matchingPendingSince: "asc" },
    take: PENDING_MATCHING_CAP,
  });
  const counts: Record<Outcome, number> = { ran: 0, deferred: 0, gaveUp: 0, errored: 0 };
  for (const row of rows) {
    counts[await rerunMatching(row).catch((err: unknown) => {
      console.error(`[workflow-mapping/matching] re-run of receipt ${row.id} failed`, err);
      return "errored" as const;
    })]++;
  }
  return counts;
}
