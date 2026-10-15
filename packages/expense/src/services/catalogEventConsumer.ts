// S5 consumer: catalog provisional-resolution events. Each event is recorded in
// ExpenseReceivedOrgEvent and applied in one transaction, so a reaction that throws rolls the
// record back; the failure is then recorded on its own and replayed by the catch-up sweep.
import { parseOrgEvent } from "@inventory/receipt-types";
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

/** Handler the catalog's post-commit call-out invokes in-process. A failed reaction is recorded, not thrown. */
export async function consumeCatalogEvent(raw: unknown): Promise<ConsumeResult> {
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
    await db.expenseReceivedOrgEvent.upsert({
      where: { id: ev.id },
      create: { id: ev.id, ...row, status: "failed", failureReason },
      update: { status: "failed", failureReason },
    });
    return "failed";
  }
}

/**
 * How far behind the cursor catch-up re-reads. Catalog ids are assigned at insert, not at
 * commit, so an event with a lower id can commit after a higher one was consumed.
 * Assumes no catalog transaction stays open while more than this many others commit; make it
 * time-based if bulk catalog edits arrive.
 */
export const CATALOG_EVENT_LOOKBACK = 100;

/**
 * Catch-up sweep: retries failed events, then reads the catalog's events from a lookback
 * window behind the cursor (max received id), skipping ids already in the ledger. The host's
 * daily reconcile cron step calls it. Capped; counts only.
 */
export async function catchUpCatalogEvents(limit = 200): Promise<Record<ConsumeResult, number>> {
  const counts: Record<ConsumeResult, number> = { processed: 0, duplicate: 0, failed: 0 };
  const repo = createOrgEventsRepository(db);
  const failed = (await repo.findPending(await getOrgId())).slice(0, limit);
  for (const r of failed) {
    counts[await consumeCatalogEvent({ id: r.id, orgId: r.orgId, eventType: r.eventType, payload: r.payload, createdAt: r.receivedAt })]++;
  }
  const from = Math.max(0, (await repo.getMaxId()) - CATALOG_EVENT_LOOKBACK);
  const received = new Set(await repo.idsAfter(from));
  const fresh = (await getExpenseRuntime().catalogEvents.eventsAfter(from)).filter(
    (raw) => !received.has(CatalogOrgEventSchema.pick({ id: true }).parse(raw).id),
  );
  for (const raw of fresh.slice(0, Math.max(0, limit - failed.length))) counts[await consumeCatalogEvent(raw)]++;
  return counts;
}
