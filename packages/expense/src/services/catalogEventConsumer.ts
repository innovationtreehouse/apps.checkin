// S5 consumer: catalog provisional-resolution events. Each event is recorded in
// ExpenseReceivedOrgEvent and applied in one transaction, so a reaction that throws rolls the
// record back; the failure is then recorded on its own and waits for a person's retry.
import { ServiceError, orgEventStep, sweepOrgEvents } from "@checkin/component-kit";
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

async function react(tx: Db, ev: CatalogOrgEvent, payload: unknown): Promise<void> {
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

const consumeRow = orgEventStep<CatalogOrgEvent, "duplicate">({
  async check(ev) {
    const existing = await db.expenseReceivedOrgEvent.findFirst({ where: { id: ev.id }, select: { status: true } });
    return existing?.status === "processed" ? "duplicate" : null;
  },
  async apply(ev) {
    const payloadText = payloadTextOf(ev);
    await db.$transaction(async (tx) => {
      await tx.expenseReceivedOrgEvent.upsert({
        where: { id: ev.id },
        create: { id: ev.id, ...ledgerRow(ev), status: "processed" },
        update: { status: "processed", failureReason: null, firstFailedAt: null },
      });
      await react(tx, ev, JSON.parse(payloadText));
    });
  },
  async recordFailure(ev, failureReason) {
    await db.expenseReceivedOrgEvent.createMany({ data: [{ id: ev.id, ...ledgerRow(ev), status: "failed", failureReason, firstFailedAt: new Date() }], skipDuplicates: true });
    // An overlapping consumer may have processed this event; its outcome stands.
    const unprocessed = { id: ev.id, status: { not: "processed" } };
    const { count } = await db.expenseReceivedOrgEvent.updateMany({ where: unprocessed, data: { status: "failed", failureReason } });
    await db.expenseReceivedOrgEvent.updateMany({ where: { ...unprocessed, firstFailedAt: null }, data: { firstFailedAt: new Date() } });
    return count > 0;
  },
  onFailure(ev, err) {
    logError("catalog_event_failed", { eventId: ev.id, eventType: ev.eventType }, err);
  },
});

function payloadTextOf(ev: CatalogOrgEvent): string {
  return typeof ev.payload === "string" ? ev.payload : JSON.stringify(ev.payload);
}

function ledgerRow(ev: CatalogOrgEvent) {
  return { orgId: ev.orgId, eventType: ev.eventType, payload: payloadTextOf(ev), receivedAt: ev.createdAt };
}

/** Apply one event and record the outcome. A failed reaction is recorded, not thrown. */
async function recordCatalogEvent(raw: unknown): Promise<ConsumeResult> {
  const ev = CatalogOrgEventSchema.parse(raw);
  await assertOrg(ev.orgId);
  return consumeRow(ev);
}

/** Handler the catalog's post-commit call-out invokes in-process. A failed event is recorded, not thrown. */
export async function consumeCatalogEvent(raw: unknown): Promise<ConsumeResult> {
  return recordCatalogEvent(raw);
}

/** Retry of a failed event: applies it once from its stored row. 404 when no event of this org is failed. */
export async function retryCatalogEvent(id: number): Promise<void> {
  const row = await db.expenseReceivedOrgEvent.findFirst({ where: { id, orgId: await getOrgId(), status: "failed" } });
  if (!row) throw new ServiceError(404, "No failed catalog event with this id");
  await recordCatalogEvent({ id: row.id, orgId: row.orgId, eventType: row.eventType, payload: row.payload, createdAt: row.receivedAt });
}

/**
 * Catch-up sweep over the org's catalog events (see `sweepOrgEvents`). The host's daily reconcile
 * cron step calls it. Capped; counts only.
 */
export async function catchUpCatalogEvents(limit = 200): Promise<Record<ConsumeResult | "unprocessed", number> & { unreadable: boolean; notConnected?: true }> {
  const orgId = await getOrgId();
  const repo = createOrgEventsRepository(db);
  const pending = await repo.findPending(orgId);
  const sweep = await sweepOrgEvents<unknown>({
    limit,
    failed: pending.map((r) => ({ id: r.id, orgId: r.orgId, eventType: r.eventType, payload: r.payload, createdAt: r.receivedAt })),
    readPage: (after) => getExpenseRuntime().catalogEvents.eventsSince(orgId, after),
    idOf: (raw) => CatalogOrgEventSchema.pick({ id: true }).parse(raw).id,
    receivedIds: (ids) => repo.idsIn(ids),
    consume: recordCatalogEvent,
    onUnrecorded: (_raw, err) => logError("catalog_event_unrecorded", {}, err),
    onUnreadable: (err) => logError("catalog_events_unreadable", {}, err),
  });
  const { processed, duplicate, failed: failedCount } = sweep.counts;
  return { processed, duplicate, failed: failedCount, unprocessed: sweep.unprocessed, unreadable: sweep.unreadable, ...(sweep.notConnected && { notConnected: true }) };
}
