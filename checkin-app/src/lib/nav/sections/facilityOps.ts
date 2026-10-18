/**
 * The Facility Ops tools (facility-ops/layout.tsx); /facility-ops redirects to
 * the viewer's first tab. Each page passes the same role list to useRequireRole,
 * so a tab never offers a page that ejects the viewer.
 */
import type { RoleFlag } from "@/lib/roles";
import type { NavSection } from "@/lib/nav/types";
import { SYSADMIN_OR_BOARD, anyRole } from "@/lib/nav/gates";

/** One person's visit record: recording, correcting, removing, the raw badge
 *  events behind it, and reviewing other people's corrections. */
export const FACILITY_RECORD_ROLES: readonly RoleFlag[] = SYSADMIN_OR_BOARD;
/** Attendance in aggregate: the trends and printing the ID badges. Operations
 *  reaches these and nothing else in this section (least privilege). */
export const FACILITY_AGGREGATE_ROLES: readonly RoleFlag[] = [...FACILITY_RECORD_ROLES, "isOperations"];

const record = anyRole(FACILITY_RECORD_ROLES);

export const FACILITY_OPS: NavSection = {
  id: "facility-ops",
  label: "Facility Ops",
  href: "/facility-ops",
  links: [
    { name: "Visit History", href: "/facility-ops/visits", icon: "🕒", visible: record },
    { name: "Raw Badge Events", href: "/facility-ops/badges", icon: "📡", visible: record },
    { name: "Print ID Badges", href: "/facility-ops/print-badges", icon: "🖨️" },
    { name: "Participation Trends", href: "/facility-ops/trends", icon: "📈" },
    { name: "Corrections", href: "/facility-ops/corrections", icon: "🛠️", visible: record },
  ],
  visible: anyRole(FACILITY_AGGREGATE_ROLES),
};
