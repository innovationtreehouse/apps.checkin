import type { StuckItem } from "@checkin/component-kit";
import { db } from "./lib/db";
import { getOrgId } from "./runtime";

/** Inventory deltas and catalog events that failed to apply. */
export async function stuckItems(): Promise<StuckItem[]> {
  const orgId = await getOrgId();
  const [deltas, events] = await Promise.all([
    db.receivedInventoryDelta.findMany({ where: { orgId, status: "failed" }, select: { id: true, receiptId: true, failureReason: true, receivedAt: true } }),
    db.inventoryReceivedOrgEvent.findMany({ where: { orgId, status: "failed" }, select: { id: true, failureReason: true, receivedAt: true } }),
  ]);
  return [
    ...deltas.map((d) => ({ id: d.receiptId ?? String(d.id), step: "inventory delta", error: d.failureReason, failedAt: d.receivedAt })),
    ...events.map((e) => ({ id: String(e.id), step: "catalog event", error: e.failureReason, failedAt: e.receivedAt })),
  ];
}
