/**
 * The System Status tools (system-status/layout.tsx); /system-status redirects
 * to the first tab. Sysadmin or board, except Unsynced Scans, which keyholders
 * also review, Finance Views, which only the Board reads (B11), and QuickBooks
 * codes, which finance also reads (FC1) and is finance's only tab here.
 */
import type { RoleFlag } from "@/lib/roles";
import type { NavSection } from "@/lib/nav/types";
import { SYSADMIN_OR_BOARD, anyRole, firstVisibleHref } from "@/lib/nav/gates";

export const SYSTEM_STATUS_ROLES = SYSADMIN_OR_BOARD;
export const UNSYNCED_REVIEW_ROLES: readonly RoleFlag[] = [...SYSADMIN_OR_BOARD, "isKeyholder"];
export const FINANCE_VIEWS_ROLES: readonly RoleFlag[] = ["isBoardMember"];
export const QBO_CODES_ROLES: readonly RoleFlag[] = [...SYSADMIN_OR_BOARD, "isFinance"];
export const QBO_CODES_PATH = "/system-status/qbo-codes";

const SYSADMIN_OR_BOARD_TAB = anyRole(SYSTEM_STATUS_ROLES);

export const SYSTEM_STATUS: NavSection = {
  id: "system-status",
  label: "System Status",
  href: "/system-status",
  links: [
    { name: "System Status", href: "/system-status/health", icon: "💚", visible: SYSADMIN_OR_BOARD_TAB },
    { name: "Link Status", href: "/system-status/links", icon: "🔗", visible: SYSADMIN_OR_BOARD_TAB },
    { name: "Lifecycle", href: "/system-status/lifecycle", icon: "🔄", visible: SYSADMIN_OR_BOARD_TAB },
    { name: "Errors", href: "/system-status/errors", icon: "🚨", visible: SYSADMIN_OR_BOARD_TAB },
    { name: "Unsynced Scans", href: "/system-status/unsynced-scans", icon: "📡", visible: anyRole(UNSYNCED_REVIEW_ROLES) },
    { name: "Audit Log", href: "/system-status/audit-log", icon: "📜", visible: SYSADMIN_OR_BOARD_TAB },
    { name: "Finance Views", href: "/system-status/finance-views", icon: "🔍", visible: anyRole(FINANCE_VIEWS_ROLES) },
    { name: "QuickBooks codes", href: QBO_CODES_PATH, icon: "🧾", visible: anyRole(QBO_CODES_ROLES) },
  ],
  visible: anyRole(QBO_CODES_ROLES),
  hrefFor: (u, c) => firstVisibleHref(SYSTEM_STATUS, u, c),
};
