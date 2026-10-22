/** The Expense Ops section: the expense library's screens and the host's /budgets. FINANCE or BOARD. */
import { EXPENSE_TABS } from "@checkin/expense/nav";
import type { NavSection } from "@/lib/nav/types";
import { FINANCE_OR_BOARD, anyRole, firstVisibleHref } from "@/lib/nav/gates";
import { libraryCount } from "@/components/navBadges";

export const EXPENSE_OPS_ROLES = FINANCE_OR_BOARD;

export const EXPENSE_OPS: NavSection = {
  id: "expense-ops",
  label: "Expense Ops",
  href: "/expense",
  links: [
    {
      ...EXPENSE_TABS.expenses,
      library: "expense",
      badge: (c) => {
        const n = libraryCount(c, "expense", "holds") + libraryCount(c, "expense", "openFlags");
        return n > 0 ? { count: n, color: "red", label: `${n} expense holds and flags` } : null;
      },
    },
    { name: "Budgets", href: "/budgets", icon: "💰", library: "expense" },
    { ...EXPENSE_TABS.settings, library: "expense" },
  ],
  visible: anyRole(EXPENSE_OPS_ROLES),
  hrefFor: (u, c) => firstVisibleHref(EXPENSE_OPS, u, c),
};
