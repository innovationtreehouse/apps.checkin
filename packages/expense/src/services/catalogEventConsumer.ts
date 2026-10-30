// S5 consumer: catalog provisional-resolution events. Each event is recorded in
// ExpenseReceivedOrgEvent and applied in one transaction, so a reaction that throws rolls the
// record back; the failure is then recorded on its own and replayed by the catch-up sweep.
import { parseOrgEvent } from "@checkin/receipt-types";
import { db, type Db } from "../db";
import { CatalogOrgEventSchema, type CatalogOrgEvent } from "../contract";
import { assertOrg, getExpenseRuntime, getOrgId } from "../runtime";
import { logError } from "../lib/logger";
import { createOrgEventsRepository } from "../repositories/orgEvents";
import { createProvisionalItemMapRepository } from "../repositories/provisionalItemMap";
import { createProvisionalResolutionRepository } from "../repositories/provisionalResolution";
import { createProvisionalItemMapService } from "./provisionalItemMapService";

export type ConsumeResult = "processed" | "duplicate" | "failed";

async function apply(tx: Db, ev: CatalogOrgEvent, payload: unknown): Promise<void> {
  const service = createProvisionalItemMapService({
    provisionalRepo: createProvisionalItemMapRepository(tx),
    resolutionRepo: createProvisionalResolutionRepository(tx),
    db: tx,
  });
  const parsed = parseOrgEvent(ev.eventType, payload);
  switch (parsed.eventType) {
    case "provisional_approved":
      return service.approveProvisional(ev.orgId, parsed.provisionalGtin13, parsed.realGtin13);
    case "provisional_rejected":
      return service.rejectProvisional(ev.orgId, parsed.provisionalGtin13, parsed.rejectionReason ?? undefined);
    case "provisional_mapped_to_existing":
      return service.mapProvisionalToExisting(ev.orgId, parsed.provisionalGtin13, parsed.realGtin13);
    default:
      // Known but not consumed here (item-reference and conversion-challenge events).
      return;
  }
}

/** Apply one event and record the outcome. A failed reaction is recorded, not thrown. */
async function recordCatalogEvent(raw: unknown): Promise<ConsumeResult> {
  const ev = CatalogOrgEventSchema.parse(raw);
  await assertOrg(ev.orgId);
  const payloadText = typeof ev.payload === "string" ? ev.payload : JSON.stringify(ev.payload);

  const existing = await db.expenseReceivedOrgEvent.findFirst({ where: { id: ev.id }, select: { status: true } });
  if (existing?.status === "processed") return "duplicate";

  const row = { orgId: ev.orgId, eventType: ev.eventType, payload: payloadText, receivedAt: ev.createdAt };
  try {
    await db.$transaction(async (tx) => {
      await tx.expenseReceivedOrgEvent.upsert({
        where: { id: ev.id },
        create: { id: ev.id, ...row, status: "processed" },
        update: { status: "processed", failureReason: null },
      });
      await apply(tx, ev, JSON.parse(payloadText));
    });
    return "processed";
  } catch (err) {
    const failureReason = err instanceof Error ? err.message : String(err);
    logError("catalog_event_failed", { eventId: ev.id, eventType: ev.eventType }, err);
    await db.expenseReceivedOrgEvent.createMany({ data: [{ id: ev.id, ...row, status: "failed", failureReason }], skipDuplicates: true });
    // An overlapping consumer may have processed this event; its outcome stands.
    const { count } = await db.expenseReceivedOrgEvent.updateMany({
      where: { id: ev.id, status: { not: "processed" } },
      data: { status: "failed", failureReason },
    });
    return count === 0 ? "duplicate" : "failed";
  }
}

/** Tell a person about events left undone. An alert that fails never fails the caller. */
async function alertStuck(event: { failed: number; unprocessed: number; unreadable: boolean }): Promise<void> {
  try {
    await getExpenseRuntime().alerts?.orgEventsStuck(event);
  } catch (err) {
    logError("catalog_event_alert_failed", {}, err);
  }
}

/** Handler the catalog's post-commit call-out invokes in-process. A failed event is recorded and alerted, not thrown. */
export async function consumeCatalogEvent(raw: unknown): Promise<ConsumeResult> {
  const result = await recordCatalogEvent(raw);
  if (result === "failed") await alertStuck({ failed: 1, unprocessed: 0, unreadable: false });
  return result;
}

/** An event that can't be recorded counts as failed; with no ledger row, the next sweep reads it again. */
async function consumeInSweep(raw: unknown): Promise<ConsumeResult> {
  try {
    return await recordCatalogEvent(raw);
  } catch (err) {
    logError("catalog_event_unrecorded", {}, err);
    return "failed";
  }
}

/**
 * Catch-up sweep: retries failed events, using at most half the cap so they can't starve new
 * events, then pages through all the org's catalog events and consumes those not in the ledger.
 * Reading from the start means no event is missed however late it committed or however many later
 * ids were received. What stays undone is retried on the next run. A person is alerted once per
 * run for an event newly failed, an unreadable catalog, or a capped run that processed nothing; a
 * capped run that made progress drains itself on later runs. The host's daily reconcile cron step
 * calls it. Capped; counts only.
 */
export async function catchUpCatalogEvents(limit = 200): Promise<Record<ConsumeResult | "unprocessed", number> & { unreadable: boolean }> {
  const counts: Record<ConsumeResult, number> = { processed: 0, duplicate: 0, failed: 0 };
  const repo = createOrgEventsRepository(db);
  const allFailed = await repo.findPending(await getOrgId());
  const retries = allFailed.slice(0, Math.ceil(limit / 2));
  for (const r of retries) {
    counts[await consumeInSweep({ id: r.id, orgId: r.orgId, eventType: r.eventType, payload: r.payload, createdAt: r.receivedAt })]++;
  }

  let unprocessed = allFailed.length - retries.length;
  let unreadable = false;
  let budget = limit - retries.length;
  let newlyFailed = 0;
  try {
    // ponytail: rereads the org's whole event history daily; keep a low-water mark if it reaches millions.
    let after = 0;
    for (;;) {
      const page = await getExpenseRuntime().catalogEvents.eventsAfter(after);
      if (page.length === 0) break;
      const ids = page.map((raw) => CatalogOrgEventSchema.pick({ id: true }).parse(raw).id);
      const received = new Set(await repo.idsIn(ids));
      for (const [i, raw] of page.entries()) {
        if (received.has(ids[i])) continue;
        if (budget > 0) {
          budget--;
          const result = await consumeInSweep(raw);
          counts[result]++;
          if (result === "failed") newlyFailed++;
        } else {
          unprocessed++;
        }
      }
      after = ids[ids.length - 1];
    }
  } catch (err) {
    unreadable = true;
    logError("catalog_events_unreadable", {}, err);
  }

  if (newlyFailed > 0 || unreadable || (unprocessed > 0 && counts.processed === 0)) await alertStuck({ failed: newlyFailed, unprocessed, unreadable });
  return { ...counts, unprocessed, unreadable };
}
