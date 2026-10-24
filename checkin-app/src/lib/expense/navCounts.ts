/**
 * Expense's nav pill counts (#1272): Expense Ops (holds, open flags), the Programs I Lead
 * "Expense approvals" tab (lines awaiting the viewer's sign-off), `approver` (1 when the viewer
 * approves any bucket: its owner or a treasurer), and per expense list view the items the
 * viewer can act on, with their sum as `actionable`. Server only.
 */
import { EXPENSE_ACTION_VIEWS, expenseActionCountKey } from "@checkin/expense/nav";
import { expenseActionCounts, expenseOpsCounts, getExpenseRuntime, signoffsAwaitingCount } from "@checkin/expense";
import type { SessionUser } from "@/types/auth";

export async function expenseLibraryCounts(user: SessionUser): Promise<Record<string, number>> {
  if (typeof user.id !== "number") return {};
  const principal = { id: user.id, name: user.name ?? null, isFinance: user.isFinance === true, isBoard: user.isBoardMember === true };
  const approver = (await getExpenseRuntime().signoff.bucketsApprovedBy(user.id)).length > 0;
  if (!approver && !principal.isFinance && !principal.isBoard) return { approver: 0 };
  const [ops, awaitingMySignoff, actions] = await Promise.all([
    expenseOpsCounts(principal),
    approver ? signoffsAwaitingCount(principal) : 0,
    expenseActionCounts(principal),
  ]);
  const perView = Object.fromEntries(EXPENSE_ACTION_VIEWS.map((v) => [expenseActionCountKey(v), actions[v]]));
  const actionable = EXPENSE_ACTION_VIEWS.reduce((sum, v) => sum + actions[v], 0);
  return { ...ops, awaitingMySignoff, approver: approver ? 1 : 0, ...perView, actionable };
}
