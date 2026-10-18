/**
 * The program-leader home (/programs-i-lead), distinct from the attendee "My
 * Programs" tab under My Activities. Lead status rides in on the todo-counts
 * payload. Expense approvals and in-kind gifts also admit program treasurers,
 * whose signal is the expense library's approver count.
 */
import { EXPENSE_TABS } from "@checkin/expense/nav";
import { BUCKET_GIFTS_TAB } from "@checkin/bulk-donation/nav";
import type { NavGate, NavSection } from "@/lib/nav/types";
import { firstVisibleHref, signedIn } from "@/lib/nav/gates";
import { leadsAnyProgram, libraryCount } from "@/components/navBadges";

const leadsProgram: NavGate = (_u, c) => leadsAnyProgram(c);
const expenseApprover: NavGate = (u, c) => (u?.programsLed?.length ?? 0) > 0 || libraryCount(c, "expense", "approver") > 0;

export const PROGRAMS_I_LEAD: NavSection = {
  id: "programs-i-lead",
  label: "Programs I Lead",
  href: "/programs-i-lead",
  links: [
    { name: "Attendance", href: "/programs-i-lead/attendance", visible: leadsProgram },
    { name: "Conflicts", href: "/programs-i-lead/conflicts", visible: leadsProgram },
    {
      ...EXPENSE_TABS.approvals,
      library: "expense",
      visible: expenseApprover,
      badge: (c) => {
        const n = libraryCount(c, "expense", "awaitingMySignoff");
        return n > 0 ? { count: n, color: "treehouseGreen", label: `${n} expense lines awaiting your sign-off` } : null;
      },
    },
    { ...BUCKET_GIFTS_TAB, library: "bulk-donation", visible: expenseApprover },
  ],
  visible: signedIn,
  hrefFor: (u, c) => (leadsAnyProgram(c) ? "/programs-i-lead" : firstVisibleHref(PROGRAMS_I_LEAD, u, c)),
};
