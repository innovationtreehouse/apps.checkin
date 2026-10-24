import { redirect } from "next/navigation";

// Attendance inbox moved to its own subtab path; bare /programs-i-lead lands there.
export default function ProgramsILeadIndex() {
  redirect("/programs-i-lead/attendance");
}
