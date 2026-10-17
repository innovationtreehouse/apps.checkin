/**
 * Single source of truth for the Membership Ops tools. Rendered as the top tab
 * bar in membership-ops/layout.tsx; the hub (/membership-ops) redirects to the
 * first entry. Add a tool once here and it shows up as a tab.
 */
import type { BusinessRole } from "@/types/auth";
import type { NavLink } from "@/lib/nav/types";

type RoleFlags = Partial<Record<BusinessRole, boolean>>;

export const MEMBERSHIP_OPS_NAV_LINKS: NavLink[] = [
  { name: "Participants", href: "/membership-ops/participants", icon: "👥" },
  // The hold reason (the merge route blind-deleted the merge-side join row on
  // collision, silently downgrading data — higher cert, ACTIVE-over-PENDING, payment
  // metadata) is dissolved: the merge route now deletes nothing — on a collision both
  // rows survive and the tombstone's row is excluded from every count/roster
  // (lib/person/filters.ts). Nothing is destroyed, so there is nothing to reconcile.
  { name: "Merge Participants", href: "/membership-ops/participants/merge", icon: "🔗" },
  { name: "Households", href: "/membership-ops/households", icon: "🏠" },
  { name: "Volunteers", href: "/membership-ops/volunteer-memberships", icon: "🙋" },
  { name: "Applications", href: "/membership-ops/applications", icon: "📋" },
  // "Unclaimed Accounts" moved to Membership Audit (/membership-audit/unclaimed).
  { name: "Background-check Review", href: "/membership-ops/review", icon: "🔍" },
  // "Broken Households" moved to Membership Audit (/membership-audit/broken).
  { name: "Roles", href: "/membership-ops/roles", icon: "🔑" },
];

/** Anyone the section admits: admin tools, plus operations (Participants only)
 *  and background-check reviewers (Review only). The section gate is the union;
 *  each tab's own visibility is `membershipOpsRouteVisible`. */
export const MEMBERSHIP_OPS_SECTION_ROLES: BusinessRole[] = [
  "isSysadmin",
  "isBoardMember",
  "isBackgroundCheckReviewer",
  "isOperations",
];

/** Sysadmin or board — full run of the admin tools. */
export const isMembershipOpsAdmin = (u: RoleFlags | undefined): boolean =>
  u?.isSysadmin === true || u?.isBoardMember === true;

/** Background-check reviewers and board members (implicit reviewers) — the
 *  Review tab only; every other tab stays admin-only. */
export const canReviewMembership = (u: RoleFlags | undefined): boolean =>
  u?.isBackgroundCheckReviewer === true || u?.isBoardMember === true;

/** Whether a viewer may open a given Membership Ops route. The one definition
 *  the layout tab filter, the left-nav and the /index directory all read. */
export function membershipOpsRouteVisible(href: string, u: RoleFlags | undefined): boolean {
  if (href === "/membership-ops/review") return canReviewMembership(u);
  if (href === "/membership-ops/participants") return isMembershipOpsAdmin(u) || u?.isOperations === true;
  return isMembershipOpsAdmin(u);
}

/** The tabs this viewer may actually open. */
export function visibleMembershipOpsLinks(u: RoleFlags | undefined): NavLink[] {
  return MEMBERSHIP_OPS_NAV_LINKS.filter((l) => membershipOpsRouteVisible(l.href, u));
}
