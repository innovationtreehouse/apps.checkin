/**
 * The program-leader home (/my-programs), distinct from the attendee "My
 * Programs" tab under My Activities. Lead status rides in on the todo-counts
 * payload. Expense approvals also admit program treasurers, whose signal is the
 * expense library's approver count.
 */
import { EXPENSE_TABS } from "@checkin/expense/nav";
import type { NavGate, NavSection } from "@/lib/nav/types";
import { firstVisibleHref, signedIn } from "@/lib/nav/gates";
import { leadsAnyProgram, libraryCount } from "@/components/navBadges";

const leadsProgram: NavGate = (_u, c) => leadsAnyProgram(c);
const expenseApprover: NavGate = (u, c) => (u?.programsLed?.length ?? 0) > 0 || libraryCount(c, "expense", "approver") > 0;

export const MY_PROGRAMS: NavSection = {
  id: "my-programs",
  label: "My Programs",
  href: "/my-programs",
  links: [
    { name: "Attendance", href: "/my-programs/attendance", visible: leadsProgram },
    { name: "Conflicts", href: "/my-programs/conflicts", visible: leadsProgram },
    {
      ...EXPENSE_TABS.approvals,
      library: "expense",
      visible: expenseApprover,
      badge: (c) => {
        const n = libraryCount(c, "expense", "awaitingMySignoff");
        return n > 0 ? { count: n, color: "treehouseGreen", label: `${n} expense lines awaiting your sign-off` } : null;
      },
    },
  ],
  visible: signedIn,
  hrefFor: (u, c) => (leadsAnyProgram(c) ? "/my-programs" : firstVisibleHref(MY_PROGRAMS, u, c)),
};
