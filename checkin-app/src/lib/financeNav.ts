/**
 * Single source of truth for the Finance Ops tools. Rendered as the persistent
 * top tabs (finance-ops/layout.tsx); /finance-ops itself redirects to the first tab.
 */
import type { BusinessRole } from "@/types/auth";
import type { NavLink } from "@/lib/nav/types";

export const FINANCE_NAV_LINKS: NavLink[] = [
  { name: "Program Payment Plan", href: "/finance-ops/payment-plan", icon: "⏳" },
  { name: "Membership Payment Plan", href: "/finance-ops/membership-payment-plan", icon: "⏳" },
  { name: "Shopify Hold Reconciliation", href: "/finance-ops/shopify-holds", icon: "🪑" },
  { name: "Payment problems", href: "/finance-ops/payments", icon: "⚠️" },
];

// Section gate — board-only; sysadmin has no access (issue #1083). The layout,
// the left-nav entry (AppFrame) and the /index directory read this one array, so
// the gate has a single definition and cannot drift (#1569).
export const FINANCE_SECTION_ROLES: BusinessRole[] = ["isBoardMember"];
