// S5 consumer: catalog provisional-resolution events. The reaction runs first and the
// ledger row (InventoryReceivedOrgEvent) records its outcome; every reaction is idempotent
// (resolution upsert, status short-circuit), so a crash between the two replays safely.
import { orgEventStep, sweepOrgEvents } from "@checkin/component-kit";
import { parseOrgEvent } from "@checkin/receipt-types";
import { db } from "../db";
import type { InventoryAlerts, OrgEventRecord } from "../../contract";
import { getCatalogEventSource, getInventoryAlerts, getOrgId, getServices } from "../../runtime";
import { createOrgEventsRepository } from "../repositories/orgEventsRepository";

export type ConsumeResult = "processed" | "duplicate" | "failed" | "skipped";

async function react(ev: OrgEventRecord): Promise<void> {
  const service = getServices().provisionalItemService;
  const parsed = parseOrgEvent(ev.eventType, JSON.parse(ev.payload));
  switch (parsed.eventType) {
    case "provisional_approved":
      return service.approveProvisional(ev.orgId, parsed.provisionalGtin13, parsed.realGtin13, ev.id, parsed.conversionFactor);
    case "provisional_rejected":
      return service.rejectProvisional(ev.orgId, parsed.provisionalGtin13, parsed.rejectionReason ?? undefined);
    case "provisional_mapped_to_existing":
      return service.mapProvisionalToExisting(ev.orgId, parsed.provisionalGtin13, parsed.realGtin13, ev.id, parsed.conversionFactor);
    default:
      // Reference verdicts and conversion challenges belong to the catalog.
      return;
  }
}

/** Writes the event's ledger row. An overlapping consumer may have processed it; its outcome stands. Returns whether this write landed. */
async function recordOutcome(ev: OrgEventRecord, status: "processed" | "failed", failureReason: string | null): Promise<boolean> {
  const row = { id: ev.id, orgId: ev.orgId, eventType: ev.eventType, payload: ev.payload, receivedAt: ev.createdAt };
  await db.inventoryReceivedOrgEvent.createMany({ data: [{ ...row, status, failureReason }], skipDuplicates: true });
  const { count } = await db.inventoryReceivedOrgEvent.updateMany({
    where: { id: ev.id, status: { not: "processed" } },
    data: { status, failureReason },
  });
  return count > 0;
}

/** Apply one event and record the outcome. A failed reaction is recorded, not thrown. */
export const consumeOrgEvent: (ev: OrgEventRecord) => Promise<ConsumeResult> = orgEventStep<OrgEventRecord, "duplicate" | "skipped">({
  async check(ev) {
    if (ev.orgId !== (await getOrgId())) {
      console.error(`[local-inventory/org-events] event ${ev.id} is for another org; skipped`);
      return "skipped";
    }
    const existing = await db.inventoryReceivedOrgEvent.findFirst({ where: { id: ev.id }, select: { status: true } });
    return existing?.status === "processed" ? "duplicate" : null;
  },
  apply: react,
  recordProcessed: async (ev) => {
    await recordOutcome(ev, "processed", null);
  },
  recordFailure: (ev, failureReason) => recordOutcome(ev, "failed", failureReason),
  onFailure(ev, err) {
    console.error(`[local-inventory/org-events] event ${ev.id} failed`, err);
  },
});

/** Tell a person about events left undone. An alert that fails never fails the caller. */
async function alertStuck(event: Parameters<InventoryAlerts["orgEventsStuck"]>[0]): Promise<void> {
  try {
    await getInventoryAlerts()?.orgEventsStuck(event);
  } catch (err) {
    console.error("[local-inventory/org-events] alert failed", err);
  }
}

/** S5 handler, registered with the catalog's post-commit call-out. */
export const orgEventConsumer = {
  async onOrgEvents(events: OrgEventRecord[]): Promise<void> {
    let failed = 0;
    for (const ev of [...events].sort((a, b) => a.id - b.id)) {
      if ((await consumeOrgEvent(ev)) === "failed") failed++;
    }
    if (failed > 0) await alertStuck({ failed, unprocessed: 0, unreadable: false });
  },
};

/**
 * Apply stored resolutions to provisionals still pending: a resolution that arrived before its
 * provisional row is otherwise applied only by the reconcile right after the creating commit.
 * Idempotent, since reconcile skips a provisional that already left pending. Capped.
 */
async function reconcilePendingProvisionals(orgId: string, limit: number): Promise<{ reconciled: number; reconcileFailed: number }> {
  // ponytail: loads every pending GTIN for the org; page it if pending provisionals reach thousands.
  const pending = await db.inventoryProvisionalItem.findMany({
    where: { orgId, status: "pending" },
    select: { provisionalGtin13: true },
  });
  if (pending.length === 0) return { reconciled: 0, reconcileFailed: 0 };
  const resolved = await db.inventoryProvisionalResolution.findMany({
    where: { orgId, provisionalGtin13: { in: pending.map((p) => p.provisionalGtin13) } },
    select: { provisionalGtin13: true },
    orderBy: { id: "asc" },
    take: limit,
  });
  const service = getServices().provisionalItemService;
  let reconciled = 0;
  let reconcileFailed = 0;
  for (const { provisionalGtin13 } of resolved) {
    try {
      await service.reconcileProvisionalOnCreate(orgId, provisionalGtin13);
      reconciled++;
    } catch (err) {
      reconcileFailed++;
      console.error(`[local-inventory/org-events] reconcile of provisional ${provisionalGtin13} failed`, err);
    }
  }
  return { reconciled, reconcileFailed };
}

/**
 * Catch-up sweep over the org's catalog events (see `sweepOrgEvents`), then reconciles pending
 * provisionals that have a stored resolution. A provisional that fails to reconcile has no ledger
 * row, so it alerts on every run until it applies. The host's daily reconcile cron step calls it.
 * Capped; counts only.
 */
export async function catchUpOrgEvents(limit = 200): Promise<Record<ConsumeResult | "reconciled" | "reconcileFailed" | "unprocessed", number> & { unreadable: boolean }> {
  const orgId = await getOrgId();
  const repo = createOrgEventsRepository(db);
  const failed = await repo.findPending(orgId);
  const sweep = await sweepOrgEvents<OrgEventRecord>({
    limit,
    failed: failed.map((r) => ({ id: r.id, orgId: r.orgId, eventType: r.eventType, payload: r.payload, createdAt: r.receivedAt })),
    readPage: (after) => getCatalogEventSource().eventsSince(orgId, after),
    idOf: (ev) => ev.id,
    receivedIds: (ids) => repo.idsIn(ids),
    consume: consumeOrgEvent,
    onUnrecorded: (ev, err) => console.error(`[local-inventory/org-events] event ${ev.id} could not be recorded`, err),
    onUnreadable: (err) => console.error("[local-inventory/org-events] catalog events could not be read", err),
  });

  const reconciled = await reconcilePendingProvisionals(orgId, limit);
  if (sweep.needsAlert || reconciled.reconcileFailed > 0) {
    await alertStuck({ failed: sweep.newlyFailed, unprocessed: sweep.unprocessed, unreadable: sweep.unreadable, reconcileFailed: reconciled.reconcileFailed });
  }
  return { ...sweep.counts, ...reconciled, unprocessed: sweep.unprocessed, unreadable: sweep.unreadable };
}
