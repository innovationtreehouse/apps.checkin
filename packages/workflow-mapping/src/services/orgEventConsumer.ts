import { parseOrgEvent, type OrgEventPayload } from "@inventory/receipt-types";
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

/** Point lines still carrying a provisional GTIN at the catalog's real item, on editable receipts only. */
async function remapProvisional(
  orgId: string,
  ev: Extract<OrgEventPayload, { eventType: "provisional_approved" | "provisional_mapped_to_existing" }>,
): Promise<void> {
  const lines = await db.receivedReceiptLineStatus.findMany({
    where: {
      provisionalItemGtin13: ev.provisionalGtin13,
      receivedReceipt: { orgId, ...EDITABLE_RECEIPT_WHERE },
      NOT: { recognitionStatus: "recognized", assignedGtin13: ev.realGtin13 },
    },
  });
  for (const line of lines) {
    const { count } = await db.receivedReceiptLineStatus.updateMany({
      where: { id: line.id, receivedReceipt: EDITABLE_RECEIPT_WHERE },
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
 * S5 handler, registered with the catalog's post-commit call-out. Applies every event it is
 * handed, in id order, including one below the cursor (a late commit); the cursor only moves
 * forward. A throw leaves the cursor behind the failed event.
 */
export const orgEventConsumer: OrgEventConsumer = {
  async onOrgEvents(events) {
    for (const event of [...events].sort((a, b) => a.id - b.id)) await applyEvent(event);
  },
};

/**
 * Catch-up sweep: replay events from a lookback window behind the cursor through the replay
 * port. Stops at the first failure (the cursor cannot skip it). Returns counts only.
 */
export async function catchUpOrgEvents(opts: { limit?: number } = {}): Promise<{ applied: number; failed: number }> {
  const limit = opts.limit ?? 500;
  const cursor = await readCursor();
  const since = Math.max(0, cursor - ORG_EVENT_LOOKBACK);
  const events = (await ports().catalogEventSource.eventsSince((await getOrg()).id, since))
    .filter((e) => e.id > since)
    .sort((a, b) => a.id - b.id)
    .slice(0, limit);

  let applied = 0;
  for (const event of events) {
    try {
      await applyEvent(event);
      applied++;
    } catch (err) {
      console.warn(`[workflow-mapping/org-events] event ${event.id} failed:`, err);
      return { applied, failed: 1 };
    }
  }
  return { applied, failed: 0 };
}
