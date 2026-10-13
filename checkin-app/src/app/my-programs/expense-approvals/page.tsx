// Stub (#1272): a bucket approver's expense queue; the list lives in the expense library.
import { ExpenseList } from "@inventory/expense/pages/expenses";

export default function Page() {
  return <ExpenseList detailBase="/my-programs/expense-approvals" defaultView="owner_approval" />;
}
