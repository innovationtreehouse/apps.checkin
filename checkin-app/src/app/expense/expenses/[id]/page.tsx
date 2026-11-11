// Stub: the screen lives in the expense library; checkin passes the id, the page it was opened from, the queue tab it returns to, and whether this is dev or local.
import ExpenseDetailPage from "@checkin/expense/pages/expenseDetail";
import { config } from "@/lib/config";
import { returnPath } from "@/lib/returnPath";
import { financeReviewHref } from "@/lib/financeReview";

export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ from?: string | string[]; queue?: string | string[] }>;
}) {
  const { id } = await params;
  const { from, queue } = await searchParams;
  const tab = Array.isArray(queue) ? queue[0] : queue;
  // Opened from a Finance review tab: `from` carries the tab and its reason chip, else the bare tab.
  const queueHref = tab ? returnPath(from, financeReviewHref(tab)) : undefined;
  return (
    <ExpenseDetailPage
      id={decodeURIComponent(id)}
      listHref={returnPath(from, "/expense/expenses")}
      queueHref={queueHref}
      testDataToggle={config.isDevInstance()}
    />
  );
}
