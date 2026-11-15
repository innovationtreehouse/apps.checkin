import { ServiceError, type StuckItem } from "@checkin/component-kit";
import { db } from "./lib/db";
import { retryOrgEvent, retryProvisionalReconcile } from "./lib/services/orgEventConsumer";
import { getOrgId, getServices } from "./runtime";

const DELTA = "inventory delta";
const CATALOG_EVENT = "catalog event";
const PROVISIONAL = "provisional item";

/**
 * Inventory deltas, catalog events, and pending provisionals whose stored catalog decision failed
 * to apply, each timed by its first failure.
 */
export async function stuckItems(): Promise<StuckItem[]> {
  const orgId = await getOrgId();
  const [deltas, events, provisionals] = await Promise.all([
    db.receivedInventoryDelta.findMany({ where: { orgId, status: "failed" }, select: { id: true, receiptId: true, receivedAt: true, firstFailedAt: true } }),
    db.inventoryReceivedOrgEvent.findMany({ where: { orgId, status: "failed" }, select: { id: true, receivedAt: true, firstFailedAt: true } }),
    db.inventoryProvisionalItem.findMany({ where: { orgId, status: "pending", reconcileFirstFailedAt: { not: null } }, select: { provisionalGtin13: true, reconcileFirstFailedAt: true } }),
  ]);
  return [
    ...deltas.map((d) => ({ id: d.receiptId ?? String(d.id), step: DELTA, href: d.receiptId ? `/receipts/${d.receiptId}` : null, failedAt: d.firstFailedAt ?? d.receivedAt })),
    ...events.map((e) => ({ id: String(e.id), step: CATALOG_EVENT, href: null, failedAt: e.firstFailedAt ?? e.receivedAt })),
    ...provisionals.flatMap((p) => (p.reconcileFirstFailedAt ? [{ id: p.provisionalGtin13, step: PROVISIONAL, href: "/inventory/provisional-items", failedAt: p.reconcileFirstFailedAt }] : [])),
  ];
}

/**
 * Runs the item's step once. Safe to repeat: the delta's "already applied" check, the event
 * ledger and the provisional's status checks hold. A step that fails again leaves the item stuck with
 * its first failure time and answers 409 with no error text; an item that is not stuck answers 404. A delta's id is its receipt id, or its row id when it has none.
 */
export async function retryStuckItem({ id, step }: { id: string; step: string }): Promise<void> {
  switch (step) {
    case DELTA: {
      const rowId = Number(id);
      const where = Number.isInteger(rowId) && String(rowId) === id ? { OR: [{ receiptId: id }, { id: rowId, receiptId: null }] } : { receiptId: id };
      return getServices().receiptService.retryFailedDelta(await getOrgId(), where);
    }
    case CATALOG_EVENT:
      return retryOrgEvent(Number(id));
    case PROVISIONAL:
      return retryProvisionalReconcile(id);
    default:
      throw new ServiceError(404, `No step ${step} in local inventory`);
  }
}
