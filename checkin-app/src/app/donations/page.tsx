import { redirect } from "next/navigation";

export default function DonationsIndex() {
  redirect("/donations/unassigned");
}
