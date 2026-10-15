// S5 consumer: catalog provisional-resolution events. The reaction runs first and the
// ledger row (InventoryReceivedOrgEvent) records its outcome; every reaction is idempotent
// (resolution upsert, status short-circuit), so a crash between the two replays safely.
import { parseOrgEvent } from "@inventory/receipt-types";
import { db } from "../db";
import type { OrgEventRecord } from "../../contract";
import { getCatalogEventSource, getOrgId, getServices } from "../../runtime";
import { createOrgEventsRepository } from "../repositories/orgEventsRepository";

export type ConsumeResult = "processed" | "duplicate" | "failed" | "skipped";

/**
 * How far behind the cursor (max received id) catch-up re-reads. Catalog ids are assigned at
 * insert, not at commit, so an event with a lower id can commit after a higher one was received.
 */
export const ORG_EVENT_LOOKBACK = 100;

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
  const row = { orgId: ev.orgId, eventType: ev.eventType, payload: ev.payload, receivedAt: ev.createdAt };
  await db.inventoryReceivedOrgEvent.upsert({
    where: { id: ev.id },
    create: { id: ev.id, ...row, status, failureReason },
    update: { status, failureReason },
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
 * Catch-up sweep: retries failed events, then reads the catalog's events from a lookback
 * window behind the cursor, skipping ids already in the ledger. The host's daily reconcile
 * cron step calls it. Capped; counts only.
 */
export async function catchUpOrgEvents(limit = 200): Promise<Record<ConsumeResult, number>> {
  const counts: Record<ConsumeResult, number> = { processed: 0, duplicate: 0, failed: 0, skipped: 0 };
  const orgId = await getOrgId();
  const repo = createOrgEventsRepository(db);
  const pending = (await repo.findPending(orgId)).slice(0, limit);
  for (const r of pending) {
    counts[await consumeOrgEvent({ id: r.id, orgId: r.orgId, eventType: r.eventType, payload: r.payload, createdAt: r.receivedAt })]++;
  }
  const from = Math.max(0, (await repo.getMaxId()) - ORG_EVENT_LOOKBACK);
  const received = new Set(await repo.idsAfter(from));
  const fresh = (await getCatalogEventSource().eventsSince(orgId, from)).filter((e) => !received.has(e.id));
  for (const ev of fresh.slice(0, Math.max(0, limit - pending.length))) counts[await consumeOrgEvent(ev)]++;
  return counts;
}
