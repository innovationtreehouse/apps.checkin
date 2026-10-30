import { parseOrgEvent, type OrgEventPayload } from "@checkin/receipt-types";
import { db } from "../db";
import { EDITABLE_RECEIPT_WHERE } from "../db/schema";
import type { OrgEventConsumer, OrgEventRecord } from "../contract";
import { insertAuditEvent } from "../lib/audit";
import { getAlerts, getOrg, ports } from "../runtime";

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
  const orgId = (await getOrg()).id;
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
async function consumeEvent(event: OrgEventRecord): Promise<boolean> {
  try {
    await applyEvent(event);
    await db.workflowAppliedOrgEvent.createMany({ data: [{ id: event.id }], skipDuplicates: true });
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
    return false;
  }
}

/** A failure-record write that throws counts as failed; with no ledger row, the next sweep reads the event again. */
async function consumeInSweep(event: OrgEventRecord): Promise<boolean> {
  try {
    return await consumeEvent(event);
  } catch (err) {
    console.error(`[workflow-mapping/org-events] event ${event.id} could not be recorded`, err);
    return false;
  }
}

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
      if (!(await consumeEvent(event))) failed++;
    }
    if (failed > 0) await alertStuck({ failed, unprocessed: 0, unreadable: false });
  },
};

/**
 * Catch-up sweep: retries recorded failures, using at most half the cap so they can't starve new
 * events, then pages through all the org's catalog events and consumes those in neither ledger.
 * Reading from the start means no event is missed however late it committed or however many later
 * ids were applied. What stays undone is retried on the next run. A person is alerted once per run
 * for an event newly failed, an unreadable catalog, or a capped run that applied nothing; a capped
 * run that made progress drains itself on later runs. Returns counts only.
 */
export async function catchUpOrgEvents(opts: { limit?: number } = {}): Promise<{ applied: number; failed: number; unprocessed: number; unreadable: boolean }> {
  const limit = opts.limit ?? 500;
  const recorded = await db.workflowFailedOrgEvent.findMany({ orderBy: { id: "asc" } });
  const retries = recorded.slice(0, Math.ceil(limit / 2));
  let applied = 0;
  let failed = 0;
  for (const r of retries) {
    if (await consumeInSweep({ id: r.id, orgId: r.orgId, eventType: r.eventType, payload: r.payload })) applied++;
    else failed++;
  }

  let unprocessed = recorded.length - retries.length;
  let unreadable = false;
  let budget = limit - retries.length;
  let newlyFailed = 0;
  try {
    const orgId = (await getOrg()).id;
    // ponytail: rereads the org's whole event history daily; keep a low-water mark if it reaches millions.
    let after = 0;
    for (;;) {
      const page = await ports().catalogEventSource.eventsSince(orgId, after);
      if (page.length === 0) break;
      const ids = page.map((e) => e.id);
      const [done, undone] = await Promise.all([
        db.workflowAppliedOrgEvent.findMany({ where: { id: { in: ids } }, select: { id: true } }),
        db.workflowFailedOrgEvent.findMany({ where: { id: { in: ids } }, select: { id: true } }),
      ]);
      const received = new Set([...done, ...undone].map((r) => r.id));
      for (const event of page) {
        if (received.has(event.id)) continue;
        if (budget > 0) {
          budget--;
          if (await consumeInSweep(event)) applied++;
          else {
            failed++;
            newlyFailed++;
          }
        } else {
          unprocessed++;
        }
      }
      after = page[page.length - 1].id;
    }
  } catch (err) {
    unreadable = true;
    console.error("[workflow-mapping/org-events] catalog events could not be read", err);
  }

  if (newlyFailed > 0 || unreadable || (unprocessed > 0 && applied === 0)) await alertStuck({ failed: newlyFailed, unprocessed, unreadable });
  return { applied, failed, unprocessed, unreadable };
}
