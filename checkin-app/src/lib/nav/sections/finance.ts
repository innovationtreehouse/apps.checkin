/**
 * The Finance section (#2481 §3): the finance queue, the expense list and the receipt flow
 * status, the bookkeeping setup screens, budgets, the held-mail queue (FINANCE alone: it shows
 * sender addresses), and the receipt settings. FINANCE or BOARD. The expense settings sit
 * under Settings.
 */
import { EXPENSE_FINANCE_TABS, FINANCE_QUEUE_COUNT_KEY } from "@checkin/expense/nav";
import { RECEIPT_FINANCE_NAV, RECEIPT_MAIL_NAV } from "@checkin/receipt/nav";
import type { RoleFlag } from "@/lib/roles";
import type { NavLink, NavSection, SectionLink } from "@/lib/nav/types";
import type { TodoCounts } from "@/lib/nav/todoCounts";
import { FINANCE_OR_BOARD, anyRole, firstVisibleHref } from "@/lib/nav/gates";
import { libraryCount, type NavBadge } from "@/components/navBadges";

export const FINANCE_ROLES = FINANCE_OR_BOARD;

export const FINANCE_REVIEW_PATH = "/finance/review";

/**
 * The one green pill: every finance queue item this viewer can act on, the receipts waiting on
 * FINANCE plus the expense tabs' actionable units. A Board member's count is the Board signatures
 * they may give.
 */
function financeReview(c: TodoCounts | null): NavBadge | null {
  const n = libraryCount(c, "receipt", "awaitingFinance") + libraryCount(c, "expense", FINANCE_QUEUE_COUNT_KEY);
  return n > 0 ? { count: n, color: "treehouseGreen", label: `${n} ${n === 1 ? "item waits" : "items wait"} on you in Finance review` } : null;
}

/** The flow status page's route admits FINANCE, BOARD or INVENTORY_MANAGER; the manager sees receiving only. */
export const RECEIPT_FLOW_ROLES: readonly RoleFlag[] = [...FINANCE_OR_BOARD, "isInventoryManager"];
export const RECEIPT_FLOW_LINK: NavLink = { name: "Flow status", href: "/receipt-flow", icon: "📊" };

const expense = (l: NavLink): SectionLink => ({ ...l, library: "expense" });
const receipt = (l: NavLink): SectionLink => ({ ...l, library: "receipt" });

export const FINANCE: NavSection = {
  id: "finance",
  label: "Finance",
  href: FINANCE_REVIEW_PATH,
  links: [
    { name: "Finance review", href: FINANCE_REVIEW_PATH, icon: "🔎", library: "receipt", badge: financeReview },
    expense(EXPENSE_FINANCE_TABS.expenses),
    receipt(RECEIPT_FLOW_LINK),
    ...EXPENSE_FINANCE_TABS.setup.map(expense),
    { name: "Budgets", href: "/budgets", icon: "💰", library: "expense" },
    { name: "Books map", href: "/books-map", icon: "🗺️", library: "expense" },
    ...RECEIPT_MAIL_NAV.map((l) => ({ ...receipt(l), visible: anyRole(["isFinance"]) })),
    ...RECEIPT_FINANCE_NAV.map(receipt),
  ],
  visible: anyRole(FINANCE_ROLES),
  hrefFor: (u, c) => firstVisibleHref(FINANCE, u, c),
};
