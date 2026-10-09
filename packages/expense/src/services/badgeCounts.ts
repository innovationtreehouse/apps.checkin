// Counts for the host's nav pills: Expense Ops (holds + open flags) and "Expense approvals"
// (lines awaiting the caller's sign-off). Each reads only the caller's own scope.
import { db } from "../db";
import type { ExpensePrincipal } from "../contract";
import { getExpenseRuntime, getOrgId } from "../runtime";
import { callerId } from "../lib/caller";
import { CLOSED_STATES, availableSigners, missingSeats, reimburseeUnknown } from "../lib/signoff";
import { filledSeatsByLine, signoffFactsByLine } from "../lib/signoff-facts";
import { listOpenFlags } from "./flagService";

/** Expenses with a pending account hold, plus flags open to the caller's audience (FINANCE, Board). */
export async function expenseOpsCount(principal: ExpensePrincipal): Promise<number> {
  if (!principal.isFinance && !principal.isBoard) return 0;
  const [held, flags] = await Promise.all([
    db.expense.count({ where: { orgId: await getOrgId(), holds: { some: { status: "PENDING" } } } }),
    listOpenFlags(principal),
  ]);
  return held + flags.length;
}

/** Lines in the caller's buckets with an open program-approver seat the caller may sign. */
export async function signoffsAwaitingCount(principal: ExpensePrincipal): Promise<number> {
  const me = callerId(principal);
  const buckets = await getExpenseRuntime().signoff.bucketsApprovedBy(me);
  if (buckets.length === 0) return 0;
  const expenses = await db.expense.findMany({
    where: { orgId: await getOrgId(), backfill: false, approvals: { some: { ownerId: { in: buckets } } } },
  });
  let count = 0;
  for (const expense of expenses) {
    if (CLOSED_STATES.has(expense.state) || reimburseeUnknown(expense)) continue;
    const [facts, filled] = await Promise.all([signoffFactsByLine(db, expense), filledSeatsByLine(db, expense.id)]);
    for (const [lineId, f] of facts) {
      const seats = filled.get(lineId) ?? [];
      if (missingSeats(f, seats).includes("PROGRAM_APPROVER") && availableSigners(f, seats, "PROGRAM_APPROVER").includes(me)) count++;
    }
  }
  return count;
}
