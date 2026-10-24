/**
 * The System Status tools (system-status/layout.tsx); /system-status redirects
 * to the first tab. Sysadmin or board, except Unsynced Scans, which keyholders
 * also review.
 */
import type { RoleFlag } from "@/lib/roles";
import type { NavSection } from "@/lib/nav/types";
import { SYSADMIN_OR_BOARD, anyRole } from "@/lib/nav/gates";

export const SYSTEM_STATUS_ROLES = SYSADMIN_OR_BOARD;
export const UNSYNCED_REVIEW_ROLES: readonly RoleFlag[] = [...SYSADMIN_OR_BOARD, "isKeyholder"];

export const SYSTEM_STATUS: NavSection = {
  id: "system-status",
  label: "System Status",
  href: "/system-status",
  links: [
    { name: "System Status", href: "/system-status/health", icon: "💚" },
    { name: "Link Status", href: "/system-status/links", icon: "🔗" },
    { name: "Lifecycle", href: "/system-status/lifecycle", icon: "🔄" },
    { name: "Errors", href: "/system-status/errors", icon: "🚨" },
    { name: "Unsynced Scans", href: "/system-status/unsynced-scans", icon: "📡", visible: anyRole(UNSYNCED_REVIEW_ROLES) },
    { name: "Audit Log", href: "/system-status/audit-log", icon: "📜" },
  ],
  visible: anyRole(SYSTEM_STATUS_ROLES),
};
