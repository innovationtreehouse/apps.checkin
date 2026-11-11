import { redirect } from "next/navigation";

// The Finance "Expenses" tab lands on the list.
export default function Page() {
  redirect("/expense/expenses");
}
