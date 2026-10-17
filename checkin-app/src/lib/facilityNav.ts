/**
 * Single source of truth for the Facility Ops tools. Rendered as the persistent
 * top tabs (facility/layout.tsx); /facility itself redirects to the first tab.
 *
 * Each link carries the roles its page gates on, and the page passes that same
 * array to useRequireRole — so a tab can never offer a page that ejects the
 * viewer, and there is no second copy of the permission table to drift (#1569).
 */
import type { BusinessRole, SessionUser } from "@/types/auth";
import type { NavLink } from "@/lib/nav/types";

export interface FacilityNavLink extends NavLink {
  roles: BusinessRole[];
}

/** One person's visit record: recording, correcting, removing, the raw badge
 *  events behind it, and reviewing other people's corrections. */
export const FACILITY_RECORD_ROLES: BusinessRole[] = ["isSysadmin", "isBoardMember"];
/** Attendance in aggregate — the trends and printing the ID badges. Operations
 *  reaches these and nothing else in this section (#1633, least privilege). */
export const FACILITY_AGGREGATE_ROLES: BusinessRole[] = [...FACILITY_RECORD_ROLES, "isOperations"];

export const FACILITY_NAV_LINKS: FacilityNavLink[] = [
  { name: "Visit History", href: "/facility-ops/visits", icon: "🕒", roles: FACILITY_RECORD_ROLES },
  { name: "Raw Badge Events", href: "/facility-ops/badges", icon: "📡", roles: FACILITY_RECORD_ROLES },
  { name: "Print ID Badges", href: "/facility-ops/print-badges", icon: "🖨️", roles: FACILITY_AGGREGATE_ROLES },
  { name: "Participation Trends", href: "/facility-ops/trends", icon: "📈", roles: FACILITY_AGGREGATE_ROLES },
  { name: "Corrections", href: "/facility-ops/corrections", icon: "🛠️", roles: FACILITY_RECORD_ROLES },
];

/** The section gate: anyone who can open at least one tab. Derived, so it can
 *  never admit someone to a tab strip with nothing in it. */
export const FACILITY_SECTION_ROLES: BusinessRole[] = [
  ...new Set(FACILITY_NAV_LINKS.flatMap((l) => l.roles)),
];

/** The tabs this viewer may actually open. */
export function visibleFacilityLinks(user: SessionUser | undefined): FacilityNavLink[] {
  return FACILITY_NAV_LINKS.filter((l) => l.roles.some((r) => user?.[r] === true));
}
