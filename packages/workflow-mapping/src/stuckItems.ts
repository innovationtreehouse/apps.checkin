import { ServiceError, type StuckItem } from "@checkin/component-kit";
import { db } from "./db";
import { executePushAndSettle } from "./lib/apply-receipt";
import { getOrgId, requireActor } from "./runtime";
import { retryFailedOrgEvent } from "./services/orgEventConsumer";
import { receiptService } from "./services/receiptService";

const APPLY = "apply";
const CATALOG_EVENT = "catalog event";

/** A receipt whose apply failed, or one left applying with a recorded failure (a lost stamp, a push that threw). */
const STUCK_RECEIPT = { OR: [{ state: "apply_failed" }, { state: "applying", applyFirstFailedAt: { not: null } }] };

/** Stuck receipts and catalog events whose reaction failed, each timed by its first failure. */
export async function stuckItems(): Promise<StuckItem[]> {
  const orgId = await getOrgId();
  const [receipts, events] = await Promise.all([
    db.receivedReceipt.findMany({ where: { orgId, ...STUCK_RECEIPT }, select: { receiptId: true, applyFirstFailedAt: true, updatedAt: true } }),
    db.workflowFailedOrgEvent.findMany({ where: { orgId }, select: { id: true, failedAt: true } }),
  ]);
  return [
    ...receipts.map((r) => ({ id: r.receiptId, step: APPLY, href: `/inventory/receiving/${r.receiptId}`, failedAt: r.applyFirstFailedAt ?? r.updatedAt })),
    ...events.map((e) => ({ id: String(e.id), step: CATALOG_EVENT, href: null, failedAt: e.failedAt })),
  ];
}

/**
 * Runs the item's step once. Safe to repeat: the apply claim and each leg's applied stamp, and the
 * event ledger, hold. A step that fails again leaves the item stuck with its first failure time;
 * one that is not stuck answers 404.
 */
export async function retryStuckItem({ id, step }: { id: string; step: string }): Promise<void> {
  switch (step) {
    case APPLY: {
      const received = await db.receivedReceipt.findFirst({ where: { receiptId: id, orgId: await getOrgId(), ...STUCK_RECEIPT } });
      if (!received) throw new ServiceError(404, "No stuck apply for this receipt");
      const actor = await requireActor();
      await receiptService.retryApply(received.id);
      if (!(await executePushAndSettle(received.id, received, actor.id, actor.name))) throw new ServiceError(409, "Receipt is already being applied");
      return;
    }
    case CATALOG_EVENT:
      return retryFailedOrgEvent(Number(id));
    default:
      throw new ServiceError(404, `No step ${step} in workflow mapping`);
  }
}
