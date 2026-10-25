// Stub (#1272): the screen lives in the expense library; the host adds its action pills.
import { ExpenseActionList } from "@/components/expense/ExpenseActionList";

export default function Page() {
  return <ExpenseActionList detailBase="/expense/expenses" defaultView="all" />;
}
