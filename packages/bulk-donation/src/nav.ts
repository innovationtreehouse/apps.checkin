/**
 * Nav descriptors for bulk donation. The library declares its screens; the host
 * places them: `DONATIONS_TAB` as the Donations section, `BENEVITY_NAV_LINKS` and
 * `IN_KIND_NAV_LINKS` as its two tab groups, and `BUCKET_GIFTS_TAB` under Programs I Lead.
 * Each group lists its screens in the order the work flows through them.
 */

export interface DonationNavLink {
  name: string;
  href: string;
  /** Emoji icon (the host's SectionTabs render an emoji string). */
  icon: string;
  /** Which DonationNavCounts field badges this tab, if any. */
  badge?: "unassignedQueue" | "disbursementHolds";
}

/** Benevity: import, every gift, owner triage, booking exceptions, booked batches, then the setup screens. */
export const BENEVITY_NAV_LINKS: readonly DonationNavLink[] = [
  { name: "Uploads", href: "/donations/uploads", icon: "📤" },
  { name: "Gifts", href: "/donations/transactions", icon: "🎁" },
  { name: "Unassigned", href: "/donations/unassigned", icon: "📥", badge: "unassignedQueue" },
  { name: "Holds", href: "/donations/holds", icon: "⛔", badge: "disbursementHolds" },
  { name: "Booking Batches", href: "/donations/events", icon: "📒" },
  { name: "Comment Rules", href: "/donations/comment-rules", icon: "💬" },
  { name: "Account Map", href: "/donations/account-map", icon: "🗺️" },
];

/** Recording an in-kind gift that has no receipt. */
export const NO_RECEIPT_GIFTS_TAB = { name: "Without a receipt", href: "/donations/in-kind-gifts", icon: "🎁" } as const;

/** In-kind: record a no-receipt gift, then finance's accept step for every gift. */
export const IN_KIND_NAV_LINKS: readonly DonationNavLink[] = [
  NO_RECEIPT_GIFTS_TAB,
  { name: "Queue", href: "/donations/in-kind", icon: "📦" },
];

/** The host-level section that holds the donation screens. */
export const DONATIONS_TAB = { name: "Donations", href: "/donations", icon: "🎁" } as const;

/** Accepted gifts of goods in the viewer's buckets, placed under the host's Programs I Lead section. */
export const BUCKET_GIFTS_TAB = { name: "In-kind gifts", href: "/programs-i-lead/in-kind-gifts", icon: "🎁" } as const;
