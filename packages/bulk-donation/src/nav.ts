/**
 * Nav descriptors for bulk donation. The library declares its screens; the host
 * places them: `DONATIONS_TAB`, `IN_KIND_TAB` and `BUCKET_GIFTS_TAB` as section
 * tabs, and `DONATION_NAV_LINKS` as the /donations second tab row.
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
  { name: "In-kind Queue", href: "/donations/in-kind", icon: "📦" },
  { name: "Booking Batches", href: "/donations/events", icon: "📒" },
  { name: "QB Queue", href: "/donations/qb-queue", icon: "🧾" },
  { name: "Comment Rules", href: "/donations/comment-rules", icon: "💬" },
  { name: "Account Map", href: "/donations/account-map", icon: "🗺️" },
  { name: "QB Exclusions", href: "/donations/qb-exclusions", icon: "🚫" },
];

/** The host-level tab that opens the donation screens. */
export const DONATIONS_TAB = { name: "Donations", href: "/donations", icon: "🎁" } as const;

/** The no-receipt in-kind gift screen, placed under the host's Inventory section. */
export const IN_KIND_TAB = { name: "In-kind gifts", href: "/inventory/in-kind", icon: "🎁" } as const;

/** Accepted gifts of goods in the viewer's buckets, placed under the host's Programs I Lead section. */
export const BUCKET_GIFTS_TAB = { name: "In-kind gifts", href: "/programs-i-lead/in-kind-gifts", icon: "🎁" } as const;
