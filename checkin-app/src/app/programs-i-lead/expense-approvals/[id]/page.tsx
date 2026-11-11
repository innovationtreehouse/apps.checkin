// Stub: the screen lives in the expense library; checkin passes the route's id and the page it was opened from.
import ExpenseDetailPage from "@checkin/expense/pages/expenseDetail";
import { returnPath } from "@/lib/returnPath";

export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ from?: string | string[] }>;
}) {
  const { id } = await params;
  const { from } = await searchParams;
  // The approvals list it was opened from is also the queue a last decision returns to.
  const approvals = returnPath(from, "/programs-i-lead/expense-approvals");
  return <ExpenseDetailPage id={decodeURIComponent(id)} listHref={approvals} queueHref={approvals} />;
}
