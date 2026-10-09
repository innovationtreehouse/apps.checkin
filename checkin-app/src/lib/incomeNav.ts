/**
 * Placement of the income screens in checkin. The library owns the screen list
 * (its `/nav` export); this file supplies checkin's section gate.
 */
import type { NavLink } from "@/lib/nav/types";
import { INCOME_NAV_LINKS } from "@inventory/income/nav";

export const INCOME_LINKS: readonly NavLink[] = INCOME_NAV_LINKS.map(({ name, href, icon }) => ({ name, href, icon }));

// FINANCE works the screens; BOARD reads them. No sysadmin: Finance Ops
// excludes sysadmins (docs/rules/finance-payments.md). Mirrors the routes'
// finance-or-board gate.
export const INCOME_SECTION_ROLES = ["isFinance", "isBoardMember"] as const;
