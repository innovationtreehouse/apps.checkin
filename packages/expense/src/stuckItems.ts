import { ServiceError, type StuckItem } from "@checkin/component-kit";
import { db } from "./db";
import { getOrgId } from "./runtime";
import { retryQbPost } from "./lib/expense-qb-processor";
import { SYSTEM_ACTOR } from "./lib/system-actor";
import { retryCatalogEvent } from "./services/catalogEventConsumer";
import { retryFailedPayload } from "./services/intakeService";

const INTAKE = "intake";
const CATALOG_EVENT = "catalog event";
const QB_POSTING = "QuickBooks posting";

/** Receipt payloads and catalog events that failed to apply, and expenses whose QuickBooks post failed, each timed by its first failure. */
export async function stuckItems(): Promise<StuckItem[]> {
  const orgId = await getOrgId();
  const [payloads, events, expenses] = await Promise.all([
    db.receivedExpensePayload.findMany({ where: { orgId, status: "failed" }, select: { receiptId: true, receivedAt: true, firstFailedAt: true } }),
    db.expenseReceivedOrgEvent.findMany({ where: { orgId, status: "failed" }, select: { id: true, receivedAt: true, firstFailedAt: true } }),
    db.expense.findMany({ where: { orgId, qbFirstFailedAt: { not: null } }, select: { id: true, qbFirstFailedAt: true } }),
  ]);
  return [
    ...payloads.map((p) => ({ id: p.receiptId, step: INTAKE, href: `/receipts/${p.receiptId}`, failedAt: p.firstFailedAt ?? p.receivedAt })),
    ...events.map((e) => ({ id: String(e.id), step: CATALOG_EVENT, href: null, failedAt: e.firstFailedAt ?? e.receivedAt })),
    ...expenses.flatMap((e) => (e.qbFirstFailedAt ? [{ id: e.id, step: QB_POSTING, href: `/expense/expenses/${e.id}`, failedAt: e.qbFirstFailedAt }] : [])),
  ];
}

/**
 * Runs the item's step once. Safe to repeat: intake's "already applied" check, the event ledger
 * and the post's claim hold. A step that fails again leaves the item stuck with its first failure
 * time; one that is not stuck answers 404.
 */
export async function retryStuckItem({ id, step }: { id: string; step: string }): Promise<void> {
  switch (step) {
    case INTAKE:
      return retryFailedPayload(id);
    case CATALOG_EVENT:
      return retryCatalogEvent(Number(id));
    case QB_POSTING: {
      const expense = await db.expense.findFirst({ where: { id, orgId: await getOrgId(), qbFirstFailedAt: { not: null } }, select: { id: true } });
      if (!expense) throw new ServiceError(404, "No failed QuickBooks post for this expense");
      const outcome = await retryQbPost(await getOrgId(), id, SYSTEM_ACTOR);
      if (outcome === false) throw new ServiceError(409, "A line no longer resolves to one QuickBooks account; fix the account mapping first");
      if (outcome === "unbound") throw new ServiceError(503, "QuickBooks isn't connected, so nothing was sent");
      return;
    }
    default:
      throw new ServiceError(404, `No step ${step} in expense`);
  }
}
