/**
 * Nav descriptors for income. The library declares its screens; the host places them:
 * `INCOME_TAB` as a section tab, and `INCOME_NAV_LINKS` as the /income second tab row.
 */

/** The nav counts income reports to the host, one per badged screen. */
export type IncomeNavCount = "openReconciliation";

export interface IncomeNavLink {
  name: string;
  href: string;
  /** Emoji icon (the host's SectionTabs render an emoji string). */
  icon: string;
  /** Which IncomeNavCount badges this screen, if any. */
  badge?: IncomeNavCount;
}

export const INCOME_NAV_LINKS: readonly IncomeNavLink[] = [
  { name: "Payouts", href: "/income/payouts", icon: "💵" },
  { name: "Reconciliation", href: "/income/reconciliation", icon: "⚠️", badge: "openReconciliation" },
  { name: "Item Categories", href: "/income/items", icon: "🏷️" },
  { name: "QB Exclusions", href: "/income/exclusions", icon: "🚫" },
];

/** The host-level tab that opens the income screens. */
export const INCOME_TAB: IncomeNavLink = { name: "Income", href: "/income", icon: "💵" };
