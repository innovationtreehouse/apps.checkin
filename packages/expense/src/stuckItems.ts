import type { StuckItem } from "@checkin/component-kit";
import { db } from "./db";
import { getOrgId } from "./runtime";

const QB_FAILED = ["qb_post_failed", "qb_needs_finance", "qb_waiting_on_settings", "qb_processing_failed"];

/** Receipt payloads and catalog events that failed to build, and expenses whose last QuickBooks post failed. */
export async function stuckItems(): Promise<StuckItem[]> {
  const orgId = await getOrgId();
  const [payloads, events, expenses] = await Promise.all([
    db.receivedExpensePayload.findMany({ where: { orgId, status: "failed" }, select: { receiptId: true, receivedAt: true } }),
    db.expenseReceivedOrgEvent.findMany({ where: { orgId, status: "failed" }, select: { id: true, receivedAt: true } }),
    db.expense.findMany({ where: { orgId, qbFailureKind: { not: null } }, select: { id: true, submittedAt: true } }),
  ]);
  const lastFailedAt = new Map<string, Date>();
  if (expenses.length) {
    const audits = await db.expenseAuditLog.findMany({
      where: { expenseId: { in: expenses.map((e) => e.id) }, action: { in: QB_FAILED } },
      orderBy: { changedAt: "asc" },
      select: { expenseId: true, changedAt: true },
    });
    for (const a of audits) lastFailedAt.set(a.expenseId, a.changedAt);
  }
  return [
    ...payloads.map((p) => ({ id: p.receiptId, step: "intake", href: `/receipts/${p.receiptId}`, failedAt: p.receivedAt })),
    ...events.map((e) => ({ id: String(e.id), step: "catalog event", href: null, failedAt: e.receivedAt })),
    ...expenses.map((e) => ({ id: e.id, step: "QuickBooks posting", href: `/expense/expenses/${e.id}`, failedAt: lastFailedAt.get(e.id) ?? e.submittedAt })),
  ];
}
