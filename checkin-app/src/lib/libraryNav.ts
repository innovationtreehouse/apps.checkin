/**
 * Nav slots the Inventory libraries register into. Each slot is a list of tabs
 * a library wiring PR appends to; the host sections (AppFrame entries and the
 * section layouts) render whatever is registered, so an empty slot hides its
 * tab — and a section made only of slots hides its sidebar entry too.
 *
 * Paths never move: a slot only groups existing routes under a section.
 */
import type { TodoCounts } from "@/lib/nav/todoCounts";
import type { NavBadge } from "@/components/navBadges";
import type { NavRole, SessionUser } from "@/types/auth";
import { isLibraryVisible, type LibraryKey } from "@/lib/libraryRelease";
import { EXPENSE_TABS } from "@inventory/expense/nav";
import { libraryCount } from "@/components/navBadges";
import { canSubmitReceipts } from "@/lib/volunteer";
import { isDonationViewerClient } from "@/lib/donationNav";

export type { LibraryKey };

/** A section tab as the host renders it. `badge` is navBadges-style: null hides the pill. */
export type NavTab = {
  name: string;
  href: string;
  icon?: string;
  badge?: (counts: TodoCounts | null) => NavBadge | null;
};

/** A tab a library registers. `visible` mirrors the tab's route gate for this viewer. */
export type LibraryTab = NavTab & {
  library: LibraryKey;
  visible: (user: SessionUser | undefined, counts: TodoCounts | null) => boolean;
};

/** The slot's tabs this viewer may see: released library AND the tab's own gate. */
export function visibleLibraryTabs(
  slot: readonly LibraryTab[],
  user: SessionUser | undefined,
  counts: TodoCounts | null,
): NavTab[] {
  const viewer = { isBoardMember: user?.isBoardMember, releasedLibraries: counts?.releasedLibraries };
  return slot
    .filter((t) => isLibraryVisible(t.library, viewer) && t.visible(user, counts))
    .map(({ name, href, icon, badge }) => ({ name, href, icon, badge }));
}

export const hasAnyRole = (user: SessionUser | undefined, roles: readonly NavRole[]): boolean =>
  roles.some((r) => user?.[r] === true);

/** Receiving's gate: the workflow-mapping read routes admit INVENTORY_MANAGER, FINANCE or BOARD. */
export const canSeeReceiving = (
  user: Pick<SessionUser, "isInventoryManager" | "isFinance" | "isBoardMember"> | undefined,
): boolean =>
  !!user?.isInventoryManager || !!user?.isFinance || !!user?.isBoardMember;

/** No-receipt in-kind gifts' gate: the list route admits FINANCE, BOARD, OPERATIONS or INVENTORY_MANAGER. */
export const canSeeManualInKind = (
  user: Pick<SessionUser, "isFinance" | "isBoardMember" | "isOperations" | "isInventoryManager"> | undefined,
): boolean =>
  !!user?.isFinance || !!user?.isBoardMember || !!user?.isOperations || !!user?.isInventoryManager;

// ---- Slots. Library wiring PRs append their tabs here. ----

/**
 * Inventory section (/catalog, /inventory): e.g. Receiving (workflow-mapping).
 * A viewer who sees any of these is admitted to the section even without the
 * catalog-viewer gate (FINANCE reaches Receiving), and then sees only these.
 */
export const INVENTORY_LIBRARY_TABS: LibraryTab[] = [
  {
    name: "Receiving",
    href: "/inventory/receiving",
    library: "workflow-mapping",
    visible: canSeeReceiving,
    badge: (c) => {
      const n = libraryCount(c, "workflow-mapping", "pending_review") + libraryCount(c, "workflow-mapping", "apply_failed");
      return n > 0 ? { count: n, color: "red", label: `${n} receipts awaiting mapping or apply` } : null;
    },
  },
  { name: "In-kind gifts", href: "/inventory/in-kind", icon: "🎁", library: "bulk-donation", visible: canSeeManualInKind },
];

/** Income's gate: the income read routes admit FINANCE or BOARD (`finance-or-board`). */
export const canSeeIncome = (user: Pick<SessionUser, "isFinance" | "isBoardMember"> | undefined): boolean =>
  !!user?.isFinance || !!user?.isBoardMember;

/** Revenue Ops section (/finance-ops, /income, /donations): Income, Donations. */
export const REVENUE_OPS_LIBRARY_TABS: LibraryTab[] = [
  {
    name: "Income",
    href: "/income",
    icon: "💵",
    library: "income",
    visible: canSeeIncome,
    badge: (c) => {
      const n = libraryCount(c, "income", "openReconciliation");
      return n > 0 ? { count: n, color: "red", label: `${n} open income reconciliation items` } : null;
    },
  },
  {
    name: "Donations",
    href: "/donations",
    icon: "🎁",
    library: "bulk-donation",
    visible: isDonationViewerClient,
    badge: (c) => {
      const n = libraryCount(c, "bulk-donation", "unassignedQueue") + libraryCount(c, "bulk-donation", "disbursementHolds");
      return n > 0 ? { count: n, color: "red", label: `${n} unassigned gifts and disbursement holds` } : null;
    },
  },
];

/** Expense Ops section (/expense, /budgets, …): Expenses, Receipts review, Budgets, Settings. */
export const EXPENSE_OPS_TABS: LibraryTab[] = [
  {
    ...EXPENSE_TABS.expenses,
    library: "expense",
    visible: (u) => !!u?.isFinance || !!u?.isBoardMember,
    badge: (c) => {
      const n = libraryCount(c, "expense", "holds") + libraryCount(c, "expense", "openFlags");
      return n > 0 ? { count: n, color: "red", label: `${n} expense holds and flags` } : null;
    },
  },
  { ...EXPENSE_TABS.settings, library: "expense", visible: (u) => !!u?.isFinance || !!u?.isBoardMember },
];

/** My Receipts top-level entry: the receipt library's own-receipt screens. */
export const MY_RECEIPTS_TABS: LibraryTab[] = [
  { name: "My receipts", href: "/receipts", icon: "🧾", library: "receipt", visible: canSubmitReceipts },
  { name: "Upload", href: "/receipts/upload", icon: "📤", library: "receipt", visible: canSubmitReceipts },
];

/** My Programs section (/my-programs): Expense approvals. */
export const MY_PROGRAMS_LIBRARY_TABS: LibraryTab[] = [
  {
    ...EXPENSE_TABS.approvals,
    library: "expense",
    // Bucket approvers: program leads, and treasurers via the expense nav counts.
    visible: (u, c) => (u?.programsLed?.length ?? 0) > 0 || libraryCount(c, "expense", "approver") > 0,
    badge: (c) => {
      const n = libraryCount(c, "expense", "awaitingMySignoff");
      return n > 0 ? { count: n, color: "treehouseGreen", label: `${n} expense lines awaiting your sign-off` } : null;
    },
  },
];

// Expense Ops admits FINANCE or BOARD; sysadmin has no access (revenue.md).
export const EXPENSE_OPS_SECTION_ROLES: NavRole[] = ["isFinance", "isBoardMember"];

export function expenseOpsTabs(user: SessionUser | undefined, counts: TodoCounts | null): NavTab[] {
  return hasAnyRole(user, EXPENSE_OPS_SECTION_ROLES) ? visibleLibraryTabs(EXPENSE_OPS_TABS, user, counts) : [];
}
