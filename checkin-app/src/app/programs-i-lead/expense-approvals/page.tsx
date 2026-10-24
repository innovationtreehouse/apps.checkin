// Stub (#1272): a bucket approver's expense queue; the list lives in the expense library.
import { ExpenseActionList } from "@/components/expense/ExpenseActionList";

export default function Page() {
  return <ExpenseActionList detailBase="/programs-i-lead/expense-approvals" defaultView="owner_approval" />;
}
