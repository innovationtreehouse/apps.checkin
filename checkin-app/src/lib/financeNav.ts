/**
 * The Revenue Ops section (path /finance-ops). Its tabs are the Board-only
 * finance tools below, then the library tabs registered in
 * REVENUE_OPS_LIBRARY_TABS (Income, Donations). Rendered as the persistent top
 * tabs by finance-ops/layout.tsx, which /income and /donations share.
 */
import type { TodoCounts } from "@/app/api/nav/todo-counts/route";
import type { NavRole, SessionUser } from "@/types/auth";
import type { NavLink } from "@/lib/nav/types";
import { REVENUE_OPS_LIBRARY_TABS, hasAnyRole, visibleLibraryTabs, type NavTab } from "@/lib/libraryNav";

export const FINANCE_NAV_LINKS: NavLink[] = [
  { name: "Program Payment Plan", href: "/finance-ops/payment-plan", icon: "⏳" },
  { name: "Membership Payment Plan", href: "/finance-ops/membership-payment-plan", icon: "⏳" },
  { name: "Shopify Hold Reconciliation", href: "/finance-ops/shopify-holds", icon: "🪑" },
  { name: "Payment problems", href: "/finance-ops/payments", icon: "⚠️" },
];

// Gate of the FINANCE_NAV_LINKS tools — board-only; sysadmin has no access
// (issue #1083). Each of those pages, its tab, the /index directory and the
// pages' API routes enforce this; widening the section never widens them.
export const FINANCE_SECTION_ROLES: NavRole[] = ["isBoardMember"];

// The section admits FINANCE or BOARD; still no sysadmin.
export const REVENUE_OPS_SECTION_ROLES: NavRole[] = ["isFinance", "isBoardMember"];

/** The Revenue Ops tabs this viewer may see; empty hides the sidebar entry. */
export function revenueOpsTabs(user: SessionUser | undefined, counts: TodoCounts | null): NavTab[] {
  if (!hasAnyRole(user, REVENUE_OPS_SECTION_ROLES)) return [];
  return [
    ...(hasAnyRole(user, FINANCE_SECTION_ROLES) ? FINANCE_NAV_LINKS : []),
    ...visibleLibraryTabs(REVENUE_OPS_LIBRARY_TABS, user, counts),
  ];
}
