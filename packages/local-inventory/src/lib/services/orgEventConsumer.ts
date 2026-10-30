// S5 consumer: catalog provisional-resolution events. The reaction runs first and the
// ledger row (InventoryReceivedOrgEvent) records its outcome; every reaction is idempotent
// (resolution upsert, status short-circuit), so a crash between the two replays safely.
import { parseOrgEvent } from "@checkin/receipt-types";
import { db } from "../db";
import type { OrgEventRecord } from "../../contract";
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

/** Apply one event and record the outcome. A failed reaction is recorded, not thrown. */
export async function consumeOrgEvent(ev: OrgEventRecord): Promise<ConsumeResult> {
  if (ev.orgId !== (await getOrgId())) {
    console.error(`[local-inventory/org-events] event ${ev.id} is for another org; skipped`);
    return "skipped";
  }
  const existing = await db.inventoryReceivedOrgEvent.findFirst({ where: { id: ev.id }, select: { status: true } });
  if (existing?.status === "processed") return "duplicate";

  let status: "processed" | "failed" = "processed";
  let failureReason: string | null = null;
  try {
    await react(ev);
  } catch (err) {
    status = "failed";
    failureReason = err instanceof Error ? err.message : String(err);
    console.error(`[local-inventory/org-events] event ${ev.id} failed`, err);
  }
  const row = { id: ev.id, orgId: ev.orgId, eventType: ev.eventType, payload: ev.payload, receivedAt: ev.createdAt };
  await db.inventoryReceivedOrgEvent.createMany({ data: [{ ...row, status, failureReason }], skipDuplicates: true });
  // An overlapping consumer may have processed this event; its outcome stands.
  await db.inventoryReceivedOrgEvent.updateMany({
    where: { id: ev.id, status: { not: "processed" } },
    data: { status, failureReason },
  });
  return status;
}

/** S5 handler, registered with the catalog's post-commit call-out. */
export const orgEventConsumer = {
  async onOrgEvents(events: OrgEventRecord[]): Promise<void> {
    for (const ev of [...events].sort((a, b) => a.id - b.id)) await consumeOrgEvent(ev);
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

/** A ledger write that throws counts as failed; with no ledger row, the next sweep reads the event again. */
async function consumeInSweep(ev: OrgEventRecord): Promise<ConsumeResult> {
  try {
    return await consumeOrgEvent(ev);
  } catch (err) {
    console.error(`[local-inventory/org-events] event ${ev.id} could not be recorded`, err);
    return "failed";
  }
}

/**
 * Catch-up sweep: retries failed events, then pages through all the org's catalog events and
 * consumes those not in the ledger, then reconciles pending provisionals that have a stored
 * resolution. Reading from the start means no event is missed however late it committed or
 * however many later ids were received. What stays undone this run is retried on the next, and
 * alerts a person once. The host's daily reconcile cron step calls it. Capped; counts only.
 */
export async function catchUpOrgEvents(limit = 200): Promise<Record<ConsumeResult | "reconciled" | "reconcileFailed" | "unprocessed", number> & { unreadable: boolean }> {
  const counts: Record<ConsumeResult, number> = { processed: 0, duplicate: 0, failed: 0, skipped: 0 };
  const orgId = await getOrgId();
  const repo = createOrgEventsRepository(db);
  const allPending = await repo.findPending(orgId);
  const pending = allPending.slice(0, limit);
  for (const r of pending) {
    counts[await consumeInSweep({ id: r.id, orgId: r.orgId, eventType: r.eventType, payload: r.payload, createdAt: r.receivedAt })]++;
  }

  let unprocessed = allPending.length - pending.length;
  let unreadable = false;
  let budget = limit - pending.length;
  try {
    // ponytail: rereads the org's whole event history daily; keep a low-water mark if it reaches millions.
    let after = 0;
    for (;;) {
      const page = await getCatalogEventSource().eventsSince(orgId, after);
      if (page.length === 0) break;
      const received = new Set(await repo.idsIn(page.map((e) => e.id)));
      for (const ev of page) {
        if (received.has(ev.id)) continue;
        if (budget > 0) {
          budget--;
          counts[await consumeInSweep(ev)]++;
        } else {
          unprocessed++;
        }
      }
      after = page[page.length - 1].id;
    }
  } catch (err) {
    unreadable = true;
    console.error("[local-inventory/org-events] catalog events could not be read", err);
  }

  const reconciled = await reconcilePendingProvisionals(orgId, limit);
  if (counts.failed > 0 || unprocessed > 0 || unreadable) {
    try {
      await getInventoryAlerts()?.orgEventsStuck({ failed: counts.failed, unprocessed, unreadable });
    } catch (err) {
      console.error("[local-inventory/org-events] alert failed", err);
    }
  }
  return { ...counts, ...reconciled, unprocessed, unreadable };
}
