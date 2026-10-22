/** The Expense Ops section: the expense library's screens and the host's /budgets. FINANCE or BOARD. */
import { EXPENSE_OPS_TABS, EXPENSE_TABS, type ExpenseNavCount } from "@checkin/expense/nav";
import type { NavSection, SectionLink } from "@/lib/nav/types";
import { FINANCE_OR_BOARD, anyRole, firstVisibleHref } from "@/lib/nav/gates";
import { libraryCount } from "@/components/navBadges";

export const EXPENSE_OPS_ROLES = FINANCE_OR_BOARD;

const COUNT_NOUNS: Record<ExpenseNavCount, string> = { holds: "expense holds", openFlags: "open expense flags" };

export const EXPENSE_OPS: NavSection = {
  id: "expense-ops",
  label: "Expense Ops",
  href: "/expense",
  links: [
    ...EXPENSE_OPS_TABS.map(({ badge: key, ...tab }): SectionLink => ({
      ...tab,
      library: "expense",
      badge: key
        ? (c) => {
            const n = libraryCount(c, "expense", key);
            return n > 0 ? { count: n, color: "red", label: `${n} ${COUNT_NOUNS[key]}` } : null;
          }
        : undefined,
    })),
    { name: "Budgets", href: "/budgets", icon: "💰", library: "expense" },
    { ...EXPENSE_TABS.settings, library: "expense" },
  ],
  visible: anyRole(EXPENSE_OPS_ROLES),
  hrefFor: (u, c) => firstVisibleHref(EXPENSE_OPS, u, c),
};
