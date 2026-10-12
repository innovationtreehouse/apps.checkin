/**
 * Nav descriptors for bulk donation (#1280 §5). The library declares its
 * screens; the host places them in its /donations section tabs and hides the
 * whole section from anyone without FINANCE or BOARD.
 */

export interface DonationNavLink {
  name: string;
  href: string;
  /** Emoji icon (the host's SectionTabs render an emoji string). */
  icon: string;
  /** Which DonationNavCounts field badges this tab, if any. */
  badge?: "unassignedQueue" | "disbursementHolds";
}

export const DONATION_NAV_LINKS: readonly DonationNavLink[] = [
  { name: "Uploads", href: "/donations/uploads", icon: "📤" },
  { name: "Unassigned", href: "/donations/unassigned", icon: "📥", badge: "unassignedQueue" },
  { name: "Gifts", href: "/donations/transactions", icon: "🎁" },
  { name: "Holds", href: "/donations/holds", icon: "⛔", badge: "disbursementHolds" },
  { name: "Booking Batches", href: "/donations/events", icon: "📒" },
  { name: "Comment Rules", href: "/donations/comment-rules", icon: "💬" },
  { name: "Account Map", href: "/donations/account-map", icon: "🗺️" },
  { name: "QB Exclusions", href: "/donations/qb-exclusions", icon: "🚫" },
];
