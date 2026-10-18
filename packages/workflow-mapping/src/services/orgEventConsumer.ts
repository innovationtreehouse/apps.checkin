import { parseOrgEvent, type OrgEventPayload } from "@checkin/receipt-types";
import { db, retryOnUniqueRace } from "../db";
import { EDITABLE_RECEIPT_WHERE } from "../db/schema";
import type { OrgEventConsumer, OrgEventRecord } from "../contract";
import { insertAuditEvent } from "../lib/audit";
import { getOrg, ports } from "../runtime";

// ponytail: one cursor row (single org); key it by org if the host goes multi-org.
const CURSOR_ROW = 1;

/**
 * How far behind the cursor catch-up re-reads. Catalog ids are assigned at insert, not at
 * commit, so an event with a lower id can commit after a higher one was applied. Every action
 * here is set-to-value or a deduped audit row, so re-applying an event changes nothing.
 * Assumes no catalog transaction stays open while more than this many others commit; make it
 * time-based if bulk catalog edits arrive.
 */
export const ORG_EVENT_LOOKBACK = 100;

/** Whether this event already wrote its audit row, so a replay does not write it again. */
async function alreadyAudited(eventType: string, eventId: number): Promise<boolean> {
  return (await db.workflowAuditLog.count({ where: { eventType, details: { contains: `"eventId":${eventId},` } } })) > 0;
}

async function readCursor(): Promise<number> {
  const row = await db.workflowSystemData.findUnique({ where: { id: CURSOR_ROW } });
  return row?.orgEventCursor ?? 0;
}

/** Move the cursor forward to `eventId`; never backward. */
async function advanceCursor(eventId: number): Promise<void> {
  await retryOnUniqueRace(() =>
    db.workflowSystemData.upsert({
      where: { id: CURSOR_ROW },
      create: { id: CURSOR_ROW, orgEventCursor: eventId },
      update: {},
    }),
  );
  await db.workflowSystemData.updateMany({
    where: { id: CURSOR_ROW, orgEventCursor: { lt: eventId } },
    data: { orgEventCursor: eventId },
  });
}

/**
 * Point lines still provisional on this GTIN at the catalog's real item, on editable receipts
 * only. A line the manager has since linked or marked not-inventory keeps that decision. Not a
 * late edit when a leg applied: inventory and expense resolve the same provisional from their own
 * S5 consumers, and the donation leg records no lines, so nothing needs a hand fix.
 */
async function remapProvisional(
  orgId: string,
  ev: Extract<OrgEventPayload, { eventType: "provisional_approved" | "provisional_mapped_to_existing" }>,
): Promise<void> {
  const lines = await db.receivedReceiptLineStatus.findMany({
    where: {
      recognitionStatus: "provisional",
      provisionalItemGtin13: ev.provisionalGtin13,
      receivedReceipt: { orgId, ...EDITABLE_RECEIPT_WHERE },
    },
  });
  for (const line of lines) {
    const { count } = await db.receivedReceiptLineStatus.updateMany({
      where: {
        id: line.id,
        recognitionStatus: "provisional",
        provisionalItemGtin13: ev.provisionalGtin13,
        receivedReceipt: EDITABLE_RECEIPT_WHERE,
      },
      data: {
        recognitionStatus: "recognized",
        assignedGtin13: ev.realGtin13,
        conversionFactor: ev.conversionFactor,
        conversionVersion: ev.conversionVersion,
      },
    });
    if (count === 0) continue;
    await insertAuditEvent(db, {
      orgId,
      actorUserId: null,
      eventType: "line_remapped",
      receivedReceiptId: line.receivedReceiptId,
      lineStatusId: line.id,
      details: JSON.stringify({
        eventType: ev.eventType,
        provisionalGtin13: ev.provisionalGtin13,
        realGtin13: ev.realGtin13,
      }),
    });
  }
}

async function applyEvent(event: OrgEventRecord): Promise<void> {
  const orgId = (await getOrg()).id;
  if (event.orgId !== orgId) {
    // Not ours to apply: record it and move past, so one stray event cannot halt the feed.
    console.error(`[workflow-mapping/org-events] event ${event.id} is for another org; skipped`);
    if (!(await alreadyAudited("org_event_rejected", event.id))) await insertAuditEvent(db, {
      orgId,
      actorUserId: null,
      eventType: "org_event_rejected",
      details: JSON.stringify({ eventId: event.id, eventType: event.eventType, reason: "foreign org" }),
    });
    await advanceCursor(event.id);
    return;
  }
  const ev = parseOrgEvent(event.eventType, JSON.parse(event.payload));

  switch (ev.eventType) {
    case "provisional_approved":
    case "provisional_mapped_to_existing":
      await remapProvisional(orgId, ev);
      break;
    case "provisional_rejected":
      // The machine has no way back to pending_review, so a rejection is recorded only.
      if (await alreadyAudited("provisional_rejected", event.id)) break;
      await insertAuditEvent(db, {
        orgId,
        actorUserId: null,
        eventType: "provisional_rejected",
        details: JSON.stringify({ eventId: event.id, provisionalGtin13: ev.provisionalGtin13, rejectionReason: ev.rejectionReason }),
      });
      break;
    default:
      // Reference verdicts and conversion challenges belong to the catalog, not the orchestrator.
      break;
  }
  await advanceCursor(event.id);
}

/**
 * Apply one event. A failure is recorded for catch-up to retry by id, and the cursor moves past
 * it, so one bad event never holds back the ones after it.
 */
async function consumeEvent(event: OrgEventRecord): Promise<boolean> {
  try {
    await applyEvent(event);
    await db.workflowFailedOrgEvent.deleteMany({ where: { id: event.id } });
    return true;
  } catch (err) {
    const failureReason = err instanceof Error ? err.message : String(err);
    console.warn(`[workflow-mapping/org-events] event ${event.id} failed:`, err);
    await db.workflowFailedOrgEvent.upsert({
      where: { id: event.id },
      create: { id: event.id, orgId: event.orgId, eventType: event.eventType, payload: event.payload, failureReason },
      update: { failureReason, failedAt: new Date() },
    });
    await advanceCursor(event.id);
    return false;
  }
}

/**
 * S5 handler, registered with the catalog's post-commit call-out. Applies every event it is
 * handed, in id order, including one below the cursor (a late commit); the cursor only moves
 * forward. A failed event is recorded, not thrown.
 */
export const orgEventConsumer: OrgEventConsumer = {
  async onOrgEvents(events) {
    for (const event of [...events].sort((a, b) => a.id - b.id)) await consumeEvent(event);
  },
};

/**
 * Catch-up sweep: retries recorded failures by id, then replays events from a lookback window
 * behind the cursor through the replay port, skipping recorded failures. Returns counts only.
 */
export async function catchUpOrgEvents(opts: { limit?: number } = {}): Promise<{ applied: number; failed: number }> {
  const limit = opts.limit ?? 500;
  const recorded = await db.workflowFailedOrgEvent.findMany({ orderBy: { id: "asc" } });
  const retries = recorded.slice(0, limit).map((r) => ({ id: r.id, orgId: r.orgId, eventType: r.eventType, payload: r.payload }));
  const since = Math.max(0, (await readCursor()) - ORG_EVENT_LOOKBACK);
  const skip = new Set(recorded.map((r) => r.id));
  const fresh = (await ports().catalogEventSource.eventsSince((await getOrg()).id, since))
    .filter((e) => e.id > since && !skip.has(e.id))
    .sort((a, b) => a.id - b.id)
    .slice(0, Math.max(0, limit - retries.length));

  let applied = 0;
  let failed = 0;
  for (const event of [...retries, ...fresh]) {
    if (await consumeEvent(event)) applied++;
    else failed++;
  }
  return { applied, failed };
}
