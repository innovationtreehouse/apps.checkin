/**
 * Expense's nav pill counts: `financeQueue` (the finance queue's actionable units, half of
 * the Finance review pill), the Programs I Lead "Expense approvals" tab (lines waiting on the
 * viewer's approval), `approver` (1 when the viewer approves any bucket: its owner or a
 * treasurer), and per expense list view the expenses the viewer can act on. A failing count is
 * left out. Server only.
 */
import { EXPENSE_ACTION_VIEWS, FINANCE_QUEUE_COUNT_KEY, expenseActionCountKey } from "@checkin/expense/nav";
import { expenseActionCounts, financeQueueActionable, getExpenseRuntime, signoffsAwaitingCount } from "@checkin/expense";
import type { SessionUser } from "@/types/auth";

/** The count, or null after logging when it fails, so one failing count leaves the others showing. */
async function orNull<T>(name: string, count: () => Promise<T>): Promise<T | null> {
  try {
    return await count();
  } catch (err) {
    console.error(`nav counts: expense ${name} failed`, err);
    return null;
  }
}

export async function expenseLibraryCounts(user: SessionUser): Promise<Record<string, number>> {
  if (typeof user.id !== "number") return {};
  const principal = { id: user.id, name: user.name ?? null, isFinance: user.isFinance === true, isBoard: user.isBoardMember === true };
  const approver = (await getExpenseRuntime().signoff.bucketsApprovedBy(user.id)).length > 0;
  if (!approver && !principal.isFinance && !principal.isBoard) return { approver: 0 };
  const finance = principal.isFinance || principal.isBoard;
  const [financeQueue, awaitingMySignoff, actions] = await Promise.all([
    finance ? orNull("finance queue count", () => financeQueueActionable(principal)) : null,
    approver ? orNull("sign-off count", () => signoffsAwaitingCount(principal)) : 0,
    orNull("action counts", () => expenseActionCounts(principal)),
  ]);
  const counted = EXPENSE_ACTION_VIEWS.flatMap((v) => (actions?.[v] === undefined ? [] : [[v, actions[v]] as const]));
  return {
    ...(financeQueue === null ? {} : { [FINANCE_QUEUE_COUNT_KEY]: financeQueue }),
    ...(awaitingMySignoff === null ? {} : { awaitingMySignoff }),
    approver: approver ? 1 : 0,
    ...Object.fromEntries(counted.map(([v, n]) => [expenseActionCountKey(v), n])),
  };
}
