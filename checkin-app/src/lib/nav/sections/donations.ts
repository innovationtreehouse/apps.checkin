/**
 * The Donations section (/donations; donations/layout.tsx): a Benevity tab and an
 * In-Kind tab, each grouping its screens as sub-tabs. The donation screens admit
 * FINANCE or BOARD. The no-receipt in-kind gift screen admits FINANCE, BOARD,
 * OPERATIONS or INVENTORY_MANAGER, like its list route.
 */
import type { RoleFlag } from "@/lib/roles";
import {
  BENEVITY_NAV_LINKS, DONATIONS_TAB, IN_KIND_NAV_LINKS, NO_RECEIPT_GIFTS_TAB, type DonationNavLink,
} from "@checkin/bulk-donation/nav";
import type { NavSection, SubLink } from "@/lib/nav/types";
import { FINANCE_OR_BOARD, anyRole, firstVisibleHref } from "@/lib/nav/gates";
import { libraryCount } from "@/components/navBadges";

export const DONATION_SCREEN_ROLES = FINANCE_OR_BOARD;
export const IN_KIND_ROLES: readonly RoleFlag[] = ["isFinance", "isBoardMember", "isOperations", "isInventoryManager"];

const COUNT_NOUNS: Record<NonNullable<DonationNavLink["badge"]>, string> = {
  unassignedQueue: "unassigned gifts",
  disbursementHolds: "disbursement holds",
};

function donationScreen({ badge: key, ...link }: DonationNavLink): SubLink {
  return {
    ...link,
    library: "bulk-donation",
    visible: anyRole(link.href === NO_RECEIPT_GIFTS_TAB.href ? IN_KIND_ROLES : DONATION_SCREEN_ROLES),
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
    { name: "Benevity", href: BENEVITY_NAV_LINKS[0].href, icon: "🏢", library: "bulk-donation", subLinks: BENEVITY_NAV_LINKS.map(donationScreen) },
    { name: "In-Kind", href: IN_KIND_NAV_LINKS[0].href, icon: "📦", library: "bulk-donation", subLinks: IN_KIND_NAV_LINKS.map(donationScreen) },
  ],
  visible: anyRole(IN_KIND_ROLES),
  hrefFor: (u, c) => firstVisibleHref(DONATIONS, u, c),
};

/** The roles the Donations layout admits on `pathname`; bare /donations sends each viewer to their first tab. */
export function donationsRolesFor(pathname: string): readonly RoleFlag[] {
  const inKindAudience = pathname === DONATIONS_TAB.href
    || pathname === NO_RECEIPT_GIFTS_TAB.href || pathname.startsWith(`${NO_RECEIPT_GIFTS_TAB.href}/`);
  return inKindAudience ? IN_KIND_ROLES : DONATION_SCREEN_ROLES;
}
