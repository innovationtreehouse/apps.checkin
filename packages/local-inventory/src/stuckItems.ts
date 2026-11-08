import { ServiceError, type StuckItem } from "@checkin/component-kit";
import { db } from "./lib/db";
import { retryOrgEvent } from "./lib/services/orgEventConsumer";
import { getOrgId, getServices } from "./runtime";

const DELTA = "inventory delta";
const CATALOG_EVENT = "catalog event";

/** Inventory deltas and catalog events that failed to apply, each timed by its first failure. */
export async function stuckItems(): Promise<StuckItem[]> {
  const orgId = await getOrgId();
  const [deltas, events] = await Promise.all([
    db.receivedInventoryDelta.findMany({ where: { orgId, status: "failed" }, select: { id: true, receiptId: true, receivedAt: true, firstFailedAt: true } }),
    db.inventoryReceivedOrgEvent.findMany({ where: { orgId, status: "failed" }, select: { id: true, receivedAt: true, firstFailedAt: true } }),
  ]);
  return [
    ...deltas.map((d) => ({ id: d.receiptId ?? String(d.id), step: DELTA, href: d.receiptId ? `/receipts/${d.receiptId}` : null, failedAt: d.firstFailedAt ?? d.receivedAt })),
    ...events.map((e) => ({ id: String(e.id), step: CATALOG_EVENT, href: null, failedAt: e.firstFailedAt ?? e.receivedAt })),
  ];
}

/**
 * Runs the item's step once. Safe to repeat: the delta's "already applied" check and the event
 * ledger hold. A step that fails again leaves the item stuck with its first failure time; an item
 * that is not stuck answers 404. A delta's id is its receipt id, or its row id when it has none.
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
    default:
      throw new ServiceError(404, `No step ${step} in local inventory`);
  }
}
