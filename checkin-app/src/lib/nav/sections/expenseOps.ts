/** The Expense Ops section: the expense library's screens and the host's /budgets. FINANCE or BOARD. */
import { EXPENSE_OPS_TABS, EXPENSE_TABS, type ExpenseNavCount } from "@checkin/expense/nav";
import type { NavSection, SectionLink } from "@/lib/nav/types";
import { FINANCE_OR_BOARD, anyRole, firstVisibleHref } from "@/lib/nav/gates";
import { libraryCount } from "@/components/navBadges";

export const EXPENSE_OPS_ROLES = FINANCE_OR_BOARD;

const COUNT_BADGES: Record<ExpenseNavCount, { noun: string; color: "red" | "treehouseGreen" }> = {
  holds: { noun: "expense holds", color: "red" },
  openFlags: { noun: "open expense flags", color: "red" },
  actionable: { noun: "expense items you can act on", color: "treehouseGreen" },
};

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
            const { noun, color } = COUNT_BADGES[key];
            return n > 0 ? { count: n, color, label: `${n} ${noun}` } : null;
          }
        : undefined,
    })),
    { name: "Budgets", href: "/budgets", icon: "💰", library: "expense" },
    { ...EXPENSE_TABS.settings, library: "expense" },
  ],
  visible: anyRole(EXPENSE_OPS_ROLES),
  hrefFor: (u, c) => firstVisibleHref(EXPENSE_OPS, u, c),
};
