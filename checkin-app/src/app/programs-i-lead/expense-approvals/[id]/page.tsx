// Stub (#1272): the screen lives in the expense library; checkin passes the route's id and the page it was opened from.
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
  return <ExpenseDetailPage id={decodeURIComponent(id)} listHref={returnPath(from, "/programs-i-lead/expense-approvals")} />;
}
