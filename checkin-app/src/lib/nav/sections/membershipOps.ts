/**
 * The Membership Ops tools (membership-ops/layout.tsx); the hub redirects to
 * the first tab. The section admits the admin tools' audience plus operations
 * (Participants only) and background-check reviewers (Review only).
 */
import type { RoleFlag } from "@/lib/roles";
import type { NavGate, NavSection } from "@/lib/nav/types";
import { SYSADMIN_OR_BOARD, anyRole } from "@/lib/nav/gates";

export const MEMBERSHIP_OPS_ROLES: readonly RoleFlag[] = [...SYSADMIN_OR_BOARD, "isBackgroundCheckReviewer", "isOperations"];

/** Sysadmin or board: the full run of the admin tools. */
export const isMembershipOpsAdmin: NavGate = anyRole(SYSADMIN_OR_BOARD);
/** Background-check reviewers and board members (implicit reviewers). */
export const canReviewMembership: NavGate = anyRole(["isBackgroundCheckReviewer", "isBoardMember"]);

export const MEMBERSHIP_OPS: NavSection = {
  id: "membership-ops",
  label: "Membership Ops",
  href: "/membership-ops",
  links: [
    { name: "Participants", href: "/membership-ops/participants", icon: "👥", visible: anyRole([...SYSADMIN_OR_BOARD, "isOperations"]) },
    { name: "Merge Participants", href: "/membership-ops/participants/merge", icon: "🔗", visible: isMembershipOpsAdmin },
    { name: "Households", href: "/membership-ops/households", icon: "🏠", visible: isMembershipOpsAdmin },
    { name: "Volunteer Families", href: "/membership-ops/volunteer-memberships", icon: "🙋", visible: isMembershipOpsAdmin },
    { name: "Applications", href: "/membership-ops/applications", icon: "📋", visible: isMembershipOpsAdmin },
    { name: "Background-check Review", href: "/membership-ops/review", icon: "🔍", visible: canReviewMembership },
    { name: "Roles", href: "/membership-ops/roles", icon: "🔑", visible: isMembershipOpsAdmin },
  ],
  visible: anyRole(MEMBERSHIP_OPS_ROLES),
  // The hub redirects to the admin-only first tab, so a reviewer-only viewer goes straight to Review.
  hrefFor: (u, c) =>
    !isMembershipOpsAdmin(u, c) && u?.isBackgroundCheckReviewer === true ? "/membership-ops/review" : "/membership-ops",
};
