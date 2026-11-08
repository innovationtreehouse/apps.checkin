import type { StuckItem } from "@checkin/component-kit";
import { db } from "./db";
import { getOrgId } from "./runtime";

/** Receipts whose apply failed, and catalog events whose reaction failed. */
export async function stuckItems(): Promise<StuckItem[]> {
  const orgId = await getOrgId();
  const [receipts, events] = await Promise.all([
    db.receivedReceipt.findMany({ where: { orgId, state: "apply_failed" }, select: { receiptId: true, updatedAt: true } }),
    db.workflowFailedOrgEvent.findMany({ where: { orgId }, select: { id: true, failureReason: true, failedAt: true } }),
  ]);
  return [
    ...receipts.map((r) => ({ id: r.receiptId, step: "apply", error: null, failedAt: r.updatedAt })),
    ...events.map((e) => ({ id: String(e.id), step: "catalog event", error: e.failureReason, failedAt: e.failedAt })),
  ];
}
