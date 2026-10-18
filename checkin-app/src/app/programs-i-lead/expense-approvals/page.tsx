// Stub (#1272): a bucket approver's expense queue; the list lives in the expense library.
import { ExpenseList } from "@checkin/expense/pages/expenses";

export default function Page() {
  return <ExpenseList detailBase="/programs-i-lead/expense-approvals" defaultView="owner_approval" />;
}
