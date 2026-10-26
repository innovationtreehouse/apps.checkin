"use client";

import { ExpenseList } from "@checkin/expense/pages/expenses";
import { useSession } from "next-auth/react";
import { EXPENSE_ACTION_VIEWS, expenseActionCountKey, expenseViewsFor, type ExpenseActionView } from "@checkin/expense/nav";
import { CountBadge } from "@/components/ui/CountBadge";
import { libraryCount } from "@/components/navBadges";
import { useTodoCounts } from "@/hooks/useTodoCounts";

const isActionView = (view: string): view is ExpenseActionView => (EXPENSE_ACTION_VIEWS as readonly string[]).includes(view);

/**
 * The expense list showing only the views the viewer can act in, with a green pill on each view
 * tab: the items there the viewer can act on. It waits for the session and the nav counts, which
 * say whether the viewer approves a bucket.
 */
export function ExpenseActionList({ detailBase, defaultView }: { detailBase: string; defaultView: string }) {
  const { data: session } = useSession();
  const counts = useTodoCounts(true);
  const viewBadge = (view: string) => {
    const n = isActionView(view) ? libraryCount(counts, "expense", expenseActionCountKey(view)) : 0;
    return n > 0 ? <CountBadge intent="action" size="sm" aria-label={`${n} you can act on`}>{n}</CountBadge> : null;
  };
  if (!session?.user || counts === null) return null;
  const views = expenseViewsFor({
    approver: libraryCount(counts, "expense", "approver") > 0,
    isFinance: session.user.isFinance === true,
    isBoard: session.user.isBoardMember === true,
  });
  return <ExpenseList detailBase={detailBase} defaultView={defaultView} views={views} viewBadge={viewBadge} />;
}
