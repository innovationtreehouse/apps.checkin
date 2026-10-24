// Stub (#1272): the screen lives in the expense library; checkin passes the id, the page it was opened from, and whether this is dev or local.
import ExpenseDetailPage from "@checkin/expense/pages/expenseDetail";
import { config } from "@/lib/config";
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
  return <ExpenseDetailPage id={decodeURIComponent(id)} listHref={returnPath(from, "/expense/expenses")} testDataToggle={config.isDevInstance()} />;
}
