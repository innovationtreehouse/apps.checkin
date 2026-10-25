"use client";

import { ExpenseList } from "@checkin/expense/pages/expenses";
import { EXPENSE_ACTION_VIEWS, expenseActionCountKey, type ExpenseActionView } from "@checkin/expense/nav";
import { CountBadge } from "@/components/ui/CountBadge";
import { libraryCount } from "@/components/navBadges";
import { useTodoCounts } from "@/hooks/useTodoCounts";

const isActionView = (view: string): view is ExpenseActionView => (EXPENSE_ACTION_VIEWS as readonly string[]).includes(view);

/** The expense list with a green pill on each view tab: the items there the viewer can act on. */
export function ExpenseActionList({ detailBase, defaultView }: { detailBase: string; defaultView: string }) {
  const counts = useTodoCounts(true);
  const viewBadge = (view: string) => {
    const n = isActionView(view) ? libraryCount(counts, "expense", expenseActionCountKey(view)) : 0;
    return n > 0 ? <CountBadge intent="action" size="sm" aria-label={`${n} you can act on`}>{n}</CountBadge> : null;
  };
  return <ExpenseList detailBase={detailBase} defaultView={defaultView} viewBadge={viewBadge} />;
}
