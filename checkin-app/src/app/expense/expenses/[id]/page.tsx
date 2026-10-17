// Stub (#1272): the screen lives in the expense library; checkin passes the id and whether this is dev or local.
import ExpenseDetailPage from "@checkin/expense/pages/expenseDetail";
import { config } from "@/lib/config";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ExpenseDetailPage id={decodeURIComponent(id)} testDataToggle={config.isDevInstance()} />;
}
