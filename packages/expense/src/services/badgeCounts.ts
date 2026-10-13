// Counts for the host's nav pills: Expense Ops (holds + open flags) and "Expense approvals"
// (lines awaiting the caller's sign-off). Each reads only the caller's own scope.
import { db } from "../db";
import type { ExpensePrincipal } from "../contract";
import { getExpenseRuntime, getOrgId } from "../runtime";
import { callerId } from "../lib/caller";
import { CLOSED_STATES, availableSigners, missingSeats } from "../lib/signoff";
import { filledSeatsByLine, signoffFactsByLine } from "../lib/signoff-facts";
import { listOpenFlags } from "./flagService";

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
 * Lines in the caller's buckets with an open program-approver seat the caller may sign, across at
 * most SIGNOFF_BADGE_EXPENSE_CAP open expenses (oldest first); past the cap it is a lower bound.
 */
export async function signoffsAwaitingCount(principal: ExpensePrincipal): Promise<number> {
  const me = callerId(principal);
  const buckets = await getExpenseRuntime().signoff.bucketsApprovedBy(me);
  if (buckets.length === 0) return 0;
  const expenses = await db.expense.findMany({
    where: {
      orgId: await getOrgId(),
      backfill: false,
      state: { notIn: [...CLOSED_STATES] },
      // A reimbursement with no reimbursee takes no sign-off (reimburseeUnknown).
      NOT: { needsReimbursement: true, reimburseePersonId: null },
      approvals: { some: { ownerId: { in: buckets } } },
    },
    orderBy: { submittedAt: "asc" },
    take: SIGNOFF_BADGE_EXPENSE_CAP,
  });
  let count = 0;
  for (const expense of expenses) {
    const [facts, filled] = await Promise.all([signoffFactsByLine(db, expense), filledSeatsByLine(db, expense.id)]);
    for (const [lineId, f] of facts) {
      const seats = filled.get(lineId) ?? [];
      if (missingSeats(f, seats).includes("PROGRAM_APPROVER") && availableSigners(f, seats, "PROGRAM_APPROVER").includes(me)) count++;
    }
  }
  return count;
}
