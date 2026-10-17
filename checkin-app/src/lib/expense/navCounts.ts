/**
 * Expense's nav pill counts (#1272): Expense Ops (holds, open flags), the My Programs
 * "Expense approvals" tab (lines awaiting the viewer's sign-off), and `approver` (1 when
 * the viewer approves any program bucket: its leader or a treasurer). Server only.
 */
import { expenseOpsCounts, getExpenseRuntime, signoffsAwaitingCount } from "@checkin/expense";
import type { SessionUser } from "@/types/auth";

export async function expenseLibraryCounts(user: SessionUser): Promise<Record<string, number>> {
  if (typeof user.id !== "number") return {};
  const principal = { id: user.id, name: user.name ?? null, isFinance: user.isFinance === true, isBoard: user.isBoardMember === true };
  const approver = (await getExpenseRuntime().signoff.bucketsApprovedBy(user.id)).length > 0;
  if (!approver && !principal.isFinance && !principal.isBoard) return { approver: 0 };
  const [ops, awaitingMySignoff] = await Promise.all([
    expenseOpsCounts(principal),
    approver ? signoffsAwaitingCount(principal) : 0,
  ]);
  return { ...ops, awaitingMySignoff, approver: approver ? 1 : 0 };
}
