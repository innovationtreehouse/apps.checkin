/**
 * Nav descriptors for income. The library declares its screens; the host places them in
 * its sections; income's screens link to each other through IncomeSubnav.
 */

export interface IncomeNavLink {
  name: string;
  href: string;
  /** Emoji icon (the host's SectionTabs render an emoji string). */
  icon: string;
}

export const INCOME_NAV_LINKS: readonly IncomeNavLink[] = [
  { name: "Payouts", href: "/income/payouts", icon: "💵" },
  { name: "Reconciliation", href: "/income/reconciliation", icon: "⚠️" },
  { name: "Item Categories", href: "/income/items", icon: "🏷️" },
  { name: "QB Exclusions", href: "/income/exclusions", icon: "🚫" },
];

