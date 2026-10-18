/**
 * Settings (settings/layout.tsx has no tab strip). The section admits sysadmin,
 * board and operations; each page's own gate is stricter, and operations' only
 * destination is Outreach.
 */
import type { RoleFlag } from "@/lib/roles";
import type { NavSection } from "@/lib/nav/types";
import { SYSADMIN_OR_BOARD, anyRole } from "@/lib/nav/gates";

export const SETTINGS_ROLES: readonly RoleFlag[] = [...SYSADMIN_OR_BOARD, "isOperations"];

const admin = anyRole(SYSADMIN_OR_BOARD);

export const SETTINGS: NavSection = {
  id: "settings",
  label: "Settings",
  href: "/settings",
  links: [
    { name: "Membership Settings", href: "/settings/membership", visible: admin },
    { name: "Localization", href: "/settings/localization", visible: anyRole(["isSysadmin"]) },
    { name: "Email Settings", href: "/settings/email", visible: admin },
    { name: "Outreach", href: "/settings/outreach" },
    { name: "Shopify Webhook", href: "/settings/shopify-webhook", visible: admin },
  ],
  visible: anyRole(SETTINGS_ROLES),
};
