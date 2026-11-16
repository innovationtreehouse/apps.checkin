/**
 * The expense list's actionable counts, read from the nav counts: per view, the items this viewer
 * can act on now (conflicted items excluded by the library's counts), and their sum. The view
 * pills and the "Expense approvals" tab and nav pill all read these, so the pills add up. A view
 * the viewer cannot act in counts 0 server side, so the sum equals the sum over the views shown.
 */
import { EXPENSE_ACTION_VIEWS, expenseActionCountKey, type ExpenseActionView } from "@checkin/expense/nav";
import { libraryCount } from "@/components/navBadges";
import type { TodoCounts } from "@/lib/nav/todoCounts";

export const isExpenseActionView = (view: string): view is ExpenseActionView =>
  (EXPENSE_ACTION_VIEWS as readonly string[]).includes(view);

export function expenseViewActionable(counts: TodoCounts | null, view: string): number {
  return isExpenseActionView(view) ? libraryCount(counts, "expense", expenseActionCountKey(view)) : 0;
}

export function expenseActionableTotal(counts: TodoCounts | null): number {
  return EXPENSE_ACTION_VIEWS.reduce((n, view) => n + expenseViewActionable(counts, view), 0);
}
