import { orgEventStep, sweepOrgEvents } from "@checkin/component-kit";
import { parseOrgEvent, type OrgEventPayload } from "@checkin/receipt-types";
import { db } from "../db";
import { EDITABLE_RECEIPT_WHERE } from "../db/schema";
import type { OrgEventConsumer, OrgEventRecord } from "../contract";
import { insertAuditEvent } from "../lib/audit";
import { getAlerts, getOrgId, ports } from "../runtime";

/** Whether this event already wrote its audit row, so a replay does not write it again. */
async function alreadyAudited(eventType: string, eventId: number): Promise<boolean> {
  return (await db.workflowAuditLog.count({ where: { eventType, details: { contains: `"eventId":${eventId},` } } })) > 0;
}

/**
 * Point lines still provisional on this GTIN at the catalog's real item, on receipts still in
 * review only: once a receipt leaves review its lines keep the mapping any apply or retry sends.
 * A line the manager has since linked or marked not-inventory keeps that decision.
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
  const orgId = await getOrgId();
  if (event.orgId !== orgId) {
    // Not ours to apply: audit it and move past, so one stray event cannot halt the feed.
    console.error(`[workflow-mapping/org-events] event ${event.id} is for another org; skipped`);
    if (!(await alreadyAudited("org_event_rejected", event.id))) await insertAuditEvent(db, {
      orgId,
      actorUserId: null,
      eventType: "org_event_rejected",
      details: JSON.stringify({ eventId: event.id, eventType: event.eventType, reason: "foreign org" }),
    });
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
}

/**
 * Apply one event, then record it in the ledger; a crash between the two replays safely, since
 * every action is set-to-value or a deduped audit row. A failure is recorded for catch-up to
 * retry by id, so one bad event never holds back the ones after it.
 */
const consumeEvent = orgEventStep<OrgEventRecord>({
  async apply(event) {
    await applyEvent(event);
    await db.workflowAppliedOrgEvent.createMany({ data: [{ id: event.id }], skipDuplicates: true });
    await db.workflowFailedOrgEvent.deleteMany({ where: { id: event.id } });
  },
  async recordFailure(event, failureReason) {
    await db.workflowFailedOrgEvent.upsert({
      where: { id: event.id },
      create: { id: event.id, orgId: event.orgId, eventType: event.eventType, payload: event.payload, failureReason },
      update: { failureReason, failedAt: new Date() },
    });
    return true;
  },
  onFailure(event, err) {
    console.warn(`[workflow-mapping/org-events] event ${event.id} failed:`, err);
  },
});

/** Tell a person about events left undone. An alert that fails never fails the caller. */
async function alertStuck(event: { failed: number; unprocessed: number; unreadable: boolean }): Promise<void> {
  try {
    await getAlerts()?.orgEventsStuck(event);
  } catch (err) {
    console.error("[workflow-mapping/org-events] alert failed", err);
  }
}

/**
 * S5 handler, registered with the catalog's post-commit call-out. Applies every event it is
 * handed, in id order. A failed event is recorded and alerted, not thrown.
 */
export const orgEventConsumer: OrgEventConsumer = {
  async onOrgEvents(events) {
    let failed = 0;
    for (const event of [...events].sort((a, b) => a.id - b.id)) {
      if ((await consumeEvent(event)) === "failed") failed++;
    }
    if (failed > 0) await alertStuck({ failed, unprocessed: 0, unreadable: false });
  },
};

/** Catch-up sweep over the org's catalog events (see `sweepOrgEvents`). An event in either ledger is not read again as new. Returns counts only. */
export async function catchUpOrgEvents(opts: { limit?: number } = {}): Promise<{ applied: number; failed: number; unprocessed: number; unreadable: boolean }> {
  const recorded = await db.workflowFailedOrgEvent.findMany({ orderBy: { id: "asc" } });
  const sweep = await sweepOrgEvents<OrgEventRecord>({
    limit: opts.limit ?? 500,
    failed: recorded.map((r) => ({ id: r.id, orgId: r.orgId, eventType: r.eventType, payload: r.payload })),
    readPage: async (after) => ports().catalogEventSource.eventsSince(await getOrgId(), after),
    idOf: (event) => event.id,
    async receivedIds(ids) {
      const [done, undone] = await Promise.all([
        db.workflowAppliedOrgEvent.findMany({ where: { id: { in: ids } }, select: { id: true } }),
        db.workflowFailedOrgEvent.findMany({ where: { id: { in: ids } }, select: { id: true } }),
      ]);
      return [...done, ...undone].map((r) => r.id);
    },
    consume: consumeEvent,
    onUnrecorded: (event, err) => console.error(`[workflow-mapping/org-events] event ${event.id} could not be recorded`, err),
    onUnreadable: (err) => console.error("[workflow-mapping/org-events] catalog events could not be read", err),
  });
  if (sweep.needsAlert) await alertStuck({ failed: sweep.newlyFailed, unprocessed: sweep.unprocessed, unreadable: sweep.unreadable });
  return { applied: sweep.counts.processed, failed: sweep.counts.failed, unprocessed: sweep.unprocessed, unreadable: sweep.unreadable };
}
