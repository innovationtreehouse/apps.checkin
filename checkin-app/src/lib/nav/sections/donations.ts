/**
 * The Donations section (/donations; donations/layout.tsx). The donation screens
 * admit FINANCE or BOARD. The no-receipt in-kind gift screen admits FINANCE,
 * BOARD, OPERATIONS or INVENTORY_MANAGER, like its list route.
 */
import type { RoleFlag } from "@/lib/roles";
import { DONATIONS_TAB, DONATION_NAV_LINKS, IN_KIND_TAB, type DonationNavLink } from "@checkin/bulk-donation/nav";
import type { NavSection, SectionLink } from "@/lib/nav/types";
import { FINANCE_OR_BOARD, anyRole, firstVisibleHref } from "@/lib/nav/gates";
import { libraryCount } from "@/components/navBadges";

export const DONATION_SCREEN_ROLES = FINANCE_OR_BOARD;
export const IN_KIND_ROLES: readonly RoleFlag[] = ["isFinance", "isBoardMember", "isOperations", "isInventoryManager"];

const COUNT_NOUNS: Record<NonNullable<DonationNavLink["badge"]>, string> = {
  unassignedQueue: "unassigned gifts",
  disbursementHolds: "disbursement holds",
};

function donationScreen({ badge: key, ...link }: DonationNavLink): SectionLink {
  return {
    ...link,
    library: "bulk-donation",
    visible: anyRole(DONATION_SCREEN_ROLES),
    ...(key && {
      badge: (c) => {
        const n = libraryCount(c, "bulk-donation", key);
        return n > 0 ? { count: n, color: "red", label: `${n} ${COUNT_NOUNS[key]}` } : null;
      },
    }),
  };
}

export const DONATIONS: NavSection = {
  id: "donations",
  label: DONATIONS_TAB.name,
  href: DONATIONS_TAB.href,
  links: [
    ...DONATION_NAV_LINKS.map(donationScreen),
    { ...IN_KIND_TAB, library: "bulk-donation", visible: anyRole(IN_KIND_ROLES) },
  ],
  visible: anyRole(IN_KIND_ROLES),
  hrefFor: (u, c) => firstVisibleHref(DONATIONS, u, c),
};

/** The roles the Donations layout admits on `pathname`. */
export function donationsRolesFor(pathname: string): readonly RoleFlag[] {
  return pathname === IN_KIND_TAB.href || pathname.startsWith(`${IN_KIND_TAB.href}/`) ? IN_KIND_ROLES : DONATION_SCREEN_ROLES;
}
