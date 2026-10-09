/**
 * Placement of the expense screens in checkin (#1272 §7). The library owns the screen list
 * (`@inventory/expense/nav`); this file supplies the role filter the `/expense` layout renders.
 * FINANCE and Board see every tab; a bucket approver sees the expense list only.
 */
import type { SessionUser } from "@/types/auth";
import type { NavLink } from "@/lib/nav/types";
import { EXPENSE_NAV_LINKS } from "@inventory/expense/nav";

export function isFinanceOrBoardClient(user: SessionUser | undefined): boolean {
  return !!user?.isFinance || !!user?.isBoardMember;
}

export function expenseAreaLinks(user: SessionUser | undefined): NavLink[] {
  const full = isFinanceOrBoardClient(user);
  return EXPENSE_NAV_LINKS.filter((l) => full || !l.financeOrBoard).map(({ name, href, icon }) => ({ name, href, icon }));
}
