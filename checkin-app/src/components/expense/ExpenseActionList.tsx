"use client";

import { ExpenseList } from "@checkin/expense/pages/expenses";
import { QueueCount } from "@checkin/receipt/pages/financeQueue";
import { useSession } from "next-auth/react";
import { expenseViewsFor } from "@checkin/expense/nav";
import { libraryCount } from "@/components/navBadges";
import { expenseViewActionable } from "@/lib/expense/actionCounts";
import { useTodoCounts } from "@/hooks/useTodoCounts";

/**
 * The expense list showing only the views the viewer can act in. Each view tab carries a green
 * pill with the items there the viewer can act on, else a gray pill with the view's total when it
 * holds only items the viewer cannot act on (their own, their household's, or one that reimburses
 * them), else none. It waits only for the session; until the nav counts say the viewer approves a
 * bucket, or when they fail, the viewer is shown as not an approver.
 */
export function ExpenseActionList({ detailBase, defaultView }: { detailBase: string; defaultView: string }) {
  const { data: session } = useSession();
  const counts = useTodoCounts(true);
  const viewBadge = (view: string, total: number | undefined, selected: boolean) => {
    const actionable = expenseViewActionable(counts, view);
    const badge = actionable > 0 ? { count: actionable, intent: "action" as const } : total ? { count: total, intent: "info" as const } : null;
    return <QueueCount badge={badge} selected={selected} />;
  };
  if (!session?.user) return null;
  const views = expenseViewsFor({
    approver: libraryCount(counts, "expense", "approver") > 0,
    isFinance: session.user.isFinance === true,
    isBoard: session.user.isBoardMember === true,
  });
  return <ExpenseList detailBase={detailBase} defaultView={defaultView} views={views} viewBadge={viewBadge} />;
}
