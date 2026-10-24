/**
 * The finance side of receipts: review and settings for FINANCE or BOARD, the
 * held-mail queue for FINANCE alone (it shows sender addresses), and the host's
 * receipt flow status page. The receipt library owns the other links.
 */
import { RECEIPT_FINANCE_NAV, RECEIPT_MAIL_NAV } from "@checkin/receipt/nav";
import type { RoleFlag } from "@/lib/roles";
import type { NavLink, NavSection } from "@/lib/nav/types";
import type { TodoCounts } from "@/lib/nav/todoCounts";
import { FINANCE_OR_BOARD, anyRole, firstVisibleHref } from "@/lib/nav/gates";
import { libraryCount, type NavBadge } from "@/components/navBadges";

/** Green pill: the org's receipts that wait on FINANCE. Its count reaches FINANCE alone. */
function awaitingFinance(c: TodoCounts | null): NavBadge | null {
  const n = libraryCount(c, "receipt", "awaitingFinance");
  return n > 0 ? { count: n, color: "treehouseGreen", label: `${n} ${n === 1 ? "receipt needs" : "receipts need"} review` } : null;
}

/** The flow status page's route admits FINANCE, BOARD or INVENTORY_MANAGER; the manager sees receiving only. */
export const RECEIPT_FLOW_ROLES: readonly RoleFlag[] = [...FINANCE_OR_BOARD, "isInventoryManager"];
export const RECEIPT_FLOW_LINK: NavLink = { name: "Flow status", href: "/receipt-flow", icon: "📊" };

export const RECEIPT_REVIEW: NavSection = {
  id: "receipt-review",
  label: "Receipt Review",
  href: "/receipts/review",
  links: [
    ...RECEIPT_FINANCE_NAV.map((l) => ({
      ...l,
      library: "receipt" as const,
      ...(l.href === "/receipts/review" ? { badge: awaitingFinance } : {}),
    })),
    ...RECEIPT_MAIL_NAV.map((l) => ({ ...l, library: "receipt" as const, visible: anyRole(["isFinance"]) })),
    { ...RECEIPT_FLOW_LINK, library: "receipt" },
  ],
  visible: anyRole(FINANCE_OR_BOARD),
  hrefFor: (u, c) => firstVisibleHref(RECEIPT_REVIEW, u, c),
};
