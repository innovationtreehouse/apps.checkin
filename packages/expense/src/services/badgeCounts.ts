// Counts for the host's nav pills: Expense Ops (holds + open flags) and "Expense approvals"
// (lines awaiting the caller's approval, the program approver's sign-off). Each reads only the
// caller's own scope.
import { db } from "../db";
import type { ExpensePrincipal } from "../contract";
import { getExpenseRuntime, getOrgId } from "../runtime";
import { callerId } from "../lib/caller";
import { approvalRefusal } from "../lib/signoff";
import { filledSeatsByLine, signoffFactsByLine } from "../lib/signoff-facts";
import { listOpenFlags } from "./flagService";
import { APPROVABLE_STATUSES } from "./approvalService";

/** Expenses with a pending account hold, and flags open to the caller's audience (FINANCE, Board). */
export async function expenseOpsCounts(principal: ExpensePrincipal): Promise<{ holds: number; openFlags: number }> {
  if (!principal.isFinance && !principal.isBoard) return { holds: 0, openFlags: 0 };
  const [holds, flags] = await Promise.all([
    db.expense.count({ where: { orgId: await getOrgId(), holds: { some: { status: "PENDING" } } } }),
    listOpenFlags(principal),
  ]);
  return { holds, openFlags: flags.length };
}

/** The most open expenses one badge poll examines, so a poll costs a fixed amount of work. */
export const SIGNOFF_BADGE_EXPENSE_CAP = 25;

/**
 * Lines in the caller's buckets waiting for an approval the caller may give, across at most
 * SIGNOFF_BADGE_EXPENSE_CAP candidate expenses (newest first); past the cap it is a lower bound.
 * The query keeps expenses in owner approval with such a line, not submitted by the caller; the
 * approval's refusals are checked per line.
 */
export async function signoffsAwaitingCount(principal: ExpensePrincipal): Promise<number> {
  const me = callerId(principal);
  const buckets = await getExpenseRuntime().signoff.bucketsApprovedBy(me);
  if (buckets.length === 0) return 0;
  const waiting = { ownerId: { in: buckets }, status: { in: [...APPROVABLE_STATUSES] } };
  const expenses = await db.expense.findMany({
    where: { orgId: await getOrgId(), backfill: false, state: "owner_approval", submitterId: { not: me }, approvals: { some: waiting } },
    orderBy: { submittedAt: "desc" },
    take: SIGNOFF_BADGE_EXPENSE_CAP,
  });
  let count = 0;
  for (const expense of expenses) {
    const [facts, filled, approvals] = await Promise.all([
      signoffFactsByLine(db, expense),
      filledSeatsByLine(db, expense.id),
      db.lineItemOwnerApproval.findMany({ where: { expenseId: expense.id, ...waiting }, select: { lineItemId: true } }),
    ]);
    for (const { lineItemId } of approvals) {
      if (approvalRefusal(facts.get(lineItemId)!, filled.get(lineItemId) ?? [], me) === null) count++;
    }
  }
  return count;
}
