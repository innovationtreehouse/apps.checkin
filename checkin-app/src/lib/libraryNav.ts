/**
 * Nav slots the Inventory libraries register into. Each slot is a list of tabs
 * a library wiring PR appends to; the host sections (AppFrame entries and the
 * section layouts) render whatever is registered, so an empty slot hides its
 * tab — and a section made only of slots hides its sidebar entry too.
 *
 * Paths never move: a slot only groups existing routes under a section.
 */
import type { TodoCounts } from "@/app/api/nav/todo-counts/route";
import type { NavBadge } from "@/components/navBadges";
import type { NavRole, SessionUser } from "@/types/auth";
import { isLibraryVisible, type LibraryKey } from "@/lib/libraryRelease";

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
  visible: (user: SessionUser | undefined) => boolean;
};

/** The slot's tabs this viewer may see: released library AND the tab's own gate. */
export function visibleLibraryTabs(
  slot: readonly LibraryTab[],
  user: SessionUser | undefined,
  counts: TodoCounts | null,
): NavTab[] {
  const viewer = { isBoardMember: user?.isBoardMember, releasedLibraries: counts?.releasedLibraries };
  return slot
    .filter((t) => isLibraryVisible(t.library, viewer) && t.visible(user))
    .map(({ name, href, icon, badge }) => ({ name, href, icon, badge }));
}

export const hasAnyRole = (user: SessionUser | undefined, roles: readonly NavRole[]): boolean =>
  roles.some((r) => user?.[r] === true);

// ---- Slots. Library wiring PRs append their tabs here. ----

/**
 * Inventory section (/catalog, /inventory): e.g. Receiving (workflow-mapping).
 * A viewer who sees any of these is admitted to the section even without the
 * catalog-viewer gate (FINANCE reaches Receiving), and then sees only these.
 */
export const INVENTORY_LIBRARY_TABS: LibraryTab[] = [];

/** Revenue Ops section (/finance-ops, /income, /donations): Income, Donations. */
export const REVENUE_OPS_LIBRARY_TABS: LibraryTab[] = [];

/** Expense Ops section (/expense, /budgets, …): Expenses, Receipts review, Budgets, Settings. */
export const EXPENSE_OPS_TABS: LibraryTab[] = [];

/** My Receipts top-level entry: the receipt library's own-receipt screens. */
export const MY_RECEIPTS_TABS: LibraryTab[] = [];

/** My Programs section (/my-programs): Expense approvals. */
export const MY_PROGRAMS_LIBRARY_TABS: LibraryTab[] = [];

// Expense Ops admits FINANCE or BOARD; sysadmin has no access (finance-payments.md).
export const EXPENSE_OPS_SECTION_ROLES: NavRole[] = ["isFinance", "isBoardMember"];

export function expenseOpsTabs(user: SessionUser | undefined, counts: TodoCounts | null): NavTab[] {
  return hasAnyRole(user, EXPENSE_OPS_SECTION_ROLES) ? visibleLibraryTabs(EXPENSE_OPS_TABS, user, counts) : [];
}
