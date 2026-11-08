import { ServiceError, type StuckItem } from "@checkin/component-kit";
import { db } from "./db";
import { getOrgId } from "./runtime";
import { checkAndProcessExpense } from "./lib/expense-qb-processor";
import { retryFailedPost } from "./lib/expense-qb-poster";
import { FAILED_AGAIN } from "./lib/retry";
import { retryRefusal } from "./services/holdService";
import { retryCatalogEvent } from "./services/catalogEventConsumer";
import { retryFailedPayload } from "./services/intakeService";

const INTAKE = "intake";
const CATALOG_EVENT = "catalog event";
const QB_PROCESSING = "QuickBooks processing";
const QB_POSTING = "QuickBooks posting";

/** An open expense whose QuickBooks post failed and waits, stuck. */
const FAILED_POST = { state: { notIn: ["qb_error", "rejected"] }, qbMatchState: "NEEDS_FINANCE", qbFirstFailedAt: { not: null } };

/**
 * Receipt payloads and catalog events that failed to apply, expenses that failed to prepare for
 * QuickBooks (qb_error), and expenses whose QuickBooks post failed (NEEDS_FINANCE with a first
 * failure), each timed by its first failure. A qb_error expense with no stamp is timed from its submission.
 */
export async function stuckItems(): Promise<StuckItem[]> {
  const orgId = await getOrgId();
  const [payloads, events, expenses] = await Promise.all([
    db.receivedExpensePayload.findMany({ where: { orgId, status: "failed" }, select: { receiptId: true, receivedAt: true, firstFailedAt: true } }),
    db.expenseReceivedOrgEvent.findMany({ where: { orgId, status: "failed" }, select: { id: true, receivedAt: true, firstFailedAt: true } }),
    db.expense.findMany({
      where: { orgId, OR: [{ state: "qb_error" }, FAILED_POST] },
      select: { id: true, state: true, qbFirstFailedAt: true, submittedAt: true },
    }),
  ]);
  return [
    ...payloads.map((p) => ({ id: p.receiptId, step: INTAKE, href: `/receipts/${p.receiptId}`, failedAt: p.firstFailedAt ?? p.receivedAt })),
    ...events.map((e) => ({ id: String(e.id), step: CATALOG_EVENT, href: null, failedAt: e.firstFailedAt ?? e.receivedAt })),
    ...expenses.map((e) => ({
      id: e.id,
      step: e.state === "qb_error" ? QB_PROCESSING : QB_POSTING,
      href: `/expense/expenses/${e.id}`,
      failedAt: e.qbFirstFailedAt ?? e.submittedAt,
    })),
  ];
}

/**
 * Runs the item's step once. Safe to repeat: intake's "already applied" check, the event ledger
 * and the post's claim hold. A step that fails again stays stuck with its first failure time and
 * answers an error that carries no error text; one that is not stuck answers 404.
 */
export async function retryStuckItem({ id, step }: { id: string; step: string }): Promise<void> {
  switch (step) {
    case INTAKE:
      return retryFailedPayload(id);
    case CATALOG_EVENT:
      return retryCatalogEvent(Number(id));
    case QB_PROCESSING: {
      const orgId = await getOrgId();
      if (!(await db.expense.findFirst({ where: { id, orgId, state: "qb_error" }, select: { id: true } }))) throw new ServiceError(404, "No failed QuickBooks processing for this expense");
      await checkAndProcessExpense(orgId, id);
      if (await db.expense.findFirst({ where: { id, state: "qb_error" }, select: { id: true } })) throw new ServiceError(409, FAILED_AGAIN);
      return;
    }
    case QB_POSTING: {
      const orgId = await getOrgId();
      if (!(await db.expense.findFirst({ where: { id, orgId, ...FAILED_POST }, select: { id: true } }))) throw new ServiceError(404, "No failed QuickBooks post for this expense");
      const refusal = retryRefusal(await retryFailedPost(orgId, id));
      if (refusal) throw refusal;
      return;
    }
    default:
      throw new ServiceError(404, `No step ${step} in expense`);
  }
}
