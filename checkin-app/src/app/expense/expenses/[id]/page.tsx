// Stub (#1272): the screen lives in the expense library; checkin passes the route's id.
import ExpenseDetailPage from "@inventory/expense/pages/expenseDetail";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ExpenseDetailPage id={decodeURIComponent(id)} />;
}
