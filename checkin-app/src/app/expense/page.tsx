import { redirect } from "next/navigation";

// The Expense Ops "Expenses" tab lands on the queue.
export default function Page() {
  redirect("/expense/expenses");
}
