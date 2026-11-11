import { redirect } from "next/navigation";

// The attendance inbox lives at its own subtab path; bare /programs-i-lead lands there.
export default function ProgramsILeadIndex() {
  redirect("/programs-i-lead/attendance");
}
