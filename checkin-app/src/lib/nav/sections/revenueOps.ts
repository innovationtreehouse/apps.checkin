/**
 * The Revenue Ops section (path /finance-ops; finance-ops/layout.tsx, shared by
 * /income and /donations). It admits FINANCE or BOARD; the finance tools are
 * board-only, and Income and Donations are the libraries' tabs. The Shopify tab
 * groups the Board-only Shopify tools with income's Shopify payout screens.
 */
import type { RoleFlag } from "@/lib/roles";
import { INCOME_NAV_LINKS, INCOME_TAB, type IncomeNavCount, type IncomeNavLink } from "@checkin/income/nav";
import { DONATIONS_TAB } from "@checkin/bulk-donation/nav";
import type { NavSection, SectionLink } from "@/lib/nav/types";
import type { TodoCounts } from "@/lib/nav/todoCounts";
import { FINANCE_OR_BOARD, anyRole, firstVisibleHref } from "@/lib/nav/gates";
import { libraryCount, type NavBadge } from "@/components/navBadges";

/** The finance tools' gate; each of those pages and its API routes enforce it too. */
export const FINANCE_TOOL_ROLES: readonly RoleFlag[] = ["isBoardMember"];
export const REVENUE_OPS_ROLES = FINANCE_OR_BOARD;

const boardOnly = anyRole(FINANCE_TOOL_ROLES);

const INCOME_COUNT_NOUNS: Record<IncomeNavCount, string> = { openReconciliation: "open income reconciliation items" };

/** Red pill for income's counts, summed over `keys`. */
export function incomeBadge(c: TodoCounts | null, keys: readonly IncomeNavCount[]): NavBadge | null {
  const n = keys.reduce((sum, k) => sum + libraryCount(c, "income", k), 0);
  return n > 0 ? { count: n, color: "red", label: `${n} ${keys.map((k) => INCOME_COUNT_NOUNS[k]).join(" and ")}` } : null;
}

/** An income screen as a sub-tab: gated by income's release, badged by its own count. */
function incomeScreen({ name, href, icon, badge }: IncomeNavLink): SectionLink {
  return { name, href, icon, library: "income", ...(badge && { badge: (c: TodoCounts | null) => incomeBadge(c, [badge]) }) };
}

/** Income's Shopify payout screens, placed under the Shopify tab. */
const SHOPIFY_INCOME_HREFS: readonly string[] = ["/income/payouts", "/income/reconciliation"];

export const SHOPIFY_NAV_LINKS: readonly SectionLink[] = [
  { name: "Shopify Hold Reconciliation", href: "/finance-ops/shopify-holds", icon: "🪑", visible: boardOnly },
  { name: "Payment problems", href: "/finance-ops/payments", icon: "⚠️", visible: boardOnly },
  { name: "Unconfirmed Shopify stock", href: "/finance-ops/shopify-stock", icon: "📦", visible: boardOnly },
  ...INCOME_NAV_LINKS.filter((l) => SHOPIFY_INCOME_HREFS.includes(l.href)).map(incomeScreen),
];

export const INCOME_SCREEN_LINKS: readonly SectionLink[] =
  INCOME_NAV_LINKS.filter((l) => !SHOPIFY_INCOME_HREFS.includes(l.href)).map(incomeScreen);

export const FINANCE_NAV_LINKS: readonly SectionLink[] = [
  { name: "Program Payment Plan", href: "/finance-ops/payment-plan", icon: "⏳", visible: boardOnly },
  { name: "Membership Payment Plan", href: "/finance-ops/membership-payment-plan", icon: "⏳", visible: boardOnly },
  { name: "Shopify", href: SHOPIFY_NAV_LINKS[0].href, icon: "🛍️", subLinks: SHOPIFY_NAV_LINKS },
];

export const REVENUE_OPS: NavSection = {
  id: "revenue-ops",
  label: "Revenue Ops",
  href: "/finance-ops",
  links: [
    ...FINANCE_NAV_LINKS,
    { ...incomeScreen(INCOME_TAB), subLinks: INCOME_SCREEN_LINKS },
    {
      ...DONATIONS_TAB,
      library: "bulk-donation",
      badge: (c) => {
        const n = libraryCount(c, "bulk-donation", "unassignedQueue") + libraryCount(c, "bulk-donation", "disbursementHolds");
        return n > 0 ? { count: n, color: "red", label: `${n} unassigned gifts and disbursement holds` } : null;
      },
    },
  ],
  visible: anyRole(REVENUE_OPS_ROLES),
  hrefFor: (u, c) => firstVisibleHref(REVENUE_OPS, u, c),
};
