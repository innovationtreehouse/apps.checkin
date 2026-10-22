/**
 * The Revenue Ops section (path /finance-ops; finance-ops/layout.tsx, shared by
 * /income and /donations). It admits FINANCE or BOARD; the finance tools are
 * board-only, and Income and Donations are the libraries' tabs.
 */
import type { RoleFlag } from "@/lib/roles";
import { INCOME_NAV_LINKS, INCOME_TAB, type IncomeNavCount } from "@checkin/income/nav";
import { DONATIONS_TAB } from "@checkin/bulk-donation/nav";
import type { NavLink, NavSection } from "@/lib/nav/types";
import type { TodoCounts } from "@/lib/nav/todoCounts";
import { FINANCE_OR_BOARD, anyRole, firstVisibleHref } from "@/lib/nav/gates";
import { libraryCount, type NavBadge } from "@/components/navBadges";

/** The finance tools' gate; each of those pages and its API routes enforce it too. */
export const FINANCE_TOOL_ROLES: readonly RoleFlag[] = ["isBoardMember"];
export const REVENUE_OPS_ROLES = FINANCE_OR_BOARD;

export const FINANCE_NAV_LINKS: readonly NavLink[] = [
  { name: "Program Payment Plan", href: "/finance-ops/payment-plan", icon: "⏳" },
  { name: "Membership Payment Plan", href: "/finance-ops/membership-payment-plan", icon: "⏳" },
  { name: "Shopify Hold Reconciliation", href: "/finance-ops/shopify-holds", icon: "🪑" },
  { name: "Payment problems", href: "/finance-ops/payments", icon: "⚠️" },
  { name: "Unconfirmed Shopify stock", href: "/finance-ops/shopify-stock", icon: "📦" },
];

/** Red pill for income's counts: the Income tab sums every screen's, each income screen tab shows its own. */
export function incomeBadge(c: TodoCounts | null, keys: readonly IncomeNavCount[]): NavBadge | null {
  const n = keys.reduce((sum, k) => sum + libraryCount(c, "income", k), 0);
  return n > 0 ? { count: n, color: "red", label: `${n} open income reconciliation items` } : null;
}

export const REVENUE_OPS: NavSection = {
  id: "revenue-ops",
  label: "Revenue Ops",
  href: "/finance-ops",
  links: [
    ...FINANCE_NAV_LINKS.map((l) => ({ ...l, visible: anyRole(FINANCE_TOOL_ROLES) })),
    {
      ...INCOME_TAB,
      library: "income",
      badge: (c) => incomeBadge(c, INCOME_NAV_LINKS.flatMap((l) => l.badge ?? [])),
    },
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
