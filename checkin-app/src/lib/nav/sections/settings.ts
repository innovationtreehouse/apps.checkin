/**
 * Settings (settings/layout.tsx has no tab strip). The section admits sysadmin,
 * board, operations and FINANCE; each page's own gate is stricter, operations'
 * only destination is Outreach, and Finance (the expense settings) admits FINANCE
 * or BOARD alone.
 */
import type { RoleFlag } from "@/lib/roles";
import { EXPENSE_TABS } from "@checkin/expense/nav";
import type { NavSection } from "@/lib/nav/types";
import { FINANCE_OR_BOARD, SYSADMIN_OR_BOARD, anyRole, firstVisibleHref } from "@/lib/nav/gates";

export const SETTINGS_ROLES: readonly RoleFlag[] = [...SYSADMIN_OR_BOARD, "isOperations"];
export const FINANCE_SETTINGS_ROLES = FINANCE_OR_BOARD;

const admin = anyRole(SYSADMIN_OR_BOARD);
const FINANCE_SETTINGS_HREF = EXPENSE_TABS.settings.href;

export const SETTINGS: NavSection = {
  id: "settings",
  label: "Settings",
  href: "/settings",
  links: [
    { name: "Membership Settings", href: "/settings/membership", visible: admin },
    { name: "Localization", href: "/settings/localization", visible: anyRole(["isSysadmin"]) },
    { name: "Email Settings", href: "/settings/email", visible: admin },
    { name: "Outreach", href: "/settings/outreach", visible: anyRole(SETTINGS_ROLES) },
    { name: "Shopify Webhook", href: "/settings/shopify-webhook", visible: admin },
    { ...EXPENSE_TABS.settings, library: "expense", visible: anyRole(FINANCE_SETTINGS_ROLES) },
  ],
  visible: anyRole([...SETTINGS_ROLES, ...FINANCE_SETTINGS_ROLES]),
  hrefFor: (u, c) => firstVisibleHref(SETTINGS, u, c),
};

/** The roles the Settings layout admits on `pathname`. */
export function settingsRolesFor(pathname: string): readonly RoleFlag[] {
  return pathname === FINANCE_SETTINGS_HREF || pathname.startsWith(`${FINANCE_SETTINGS_HREF}/`) ? FINANCE_SETTINGS_ROLES : SETTINGS_ROLES;
}
