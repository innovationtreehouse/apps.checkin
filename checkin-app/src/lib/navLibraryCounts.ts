/**
 * Per-library nav pill counts for /api/nav/todo-counts. A library wiring PR
 * registers one provider in LIBRARY_COUNT_PROVIDERS; its counts reach the
 * client as `counts.libraries[library]`, read by badge functions via
 * navBadges' libraryCount().
 */
import type { SessionUser } from "@/types/auth";
import { isLibraryVisible, type LibraryKey } from "@/lib/libraryRelease";
import { FINANCE_OR_BOARD, hasAnyRole } from "@/lib/nav/gates";
import { RECEIVING_ROLES } from "@/lib/nav/sections/inventory";
import { canSubmitReceipts } from "@/lib/volunteer";

export type LibraryCounts = Partial<Record<LibraryKey, Record<string, number>>>;

export type LibraryCountProvider = {
  library: LibraryKey;
  /** Whether this viewer may see the counts — mirror the library's read gate. */
  visible: (user: SessionUser) => boolean;
  /** Named counts for this viewer, e.g. { holds: 2, openFlags: 1 }. */
  count: (user: SessionUser) => Promise<Record<string, number>>;
};

/** Registered providers. Library wiring PRs append theirs here. */
export const LIBRARY_COUNT_PROVIDERS: LibraryCountProvider[] = [
  {
    library: "expense",
    // Any signed-in person: a bucket approver holds no session flag, so the provider decides.
    visible: (u) => typeof u.id === "number",
    // An unconfigured library contributes no counts; lazy so the expense library loads only when used.
    count: async (u) =>
      process.env.EXPENSE_DATABASE_URL ? (await import("@/lib/expense/navCounts")).expenseLibraryCounts(u) : {},
  },
  {
    library: "bulk-donation",
    visible: (u) => hasAnyRole(u, FINANCE_OR_BOARD),
    count: async (): Promise<Record<string, number>> => {
      if (!process.env.BULK_DONATION_DATABASE_URL) return {};
      const { getNavCounts, getOrgId } = await import("@checkin/bulk-donation");
      const { unassignedQueue, disbursementHolds } = await getNavCounts(await getOrgId());
      return { unassignedQueue, disbursementHolds };
    },
  },
  {
    library: "workflow-mapping",
    visible: (u) => hasAnyRole(u, RECEIVING_ROLES),
    count: async () =>
      process.env.WORKFLOW_MAPPING_DATABASE_URL ? (await import("@checkin/workflow-mapping")).receiptService.counts() : {},
  },
  {
    library: "receipt",
    visible: (u) => typeof u.id === "number" && canSubmitReceipts(u),
    count: async (u): Promise<Record<string, number>> =>
      process.env.RECEIPT_DATABASE_URL && typeof u.id === "number"
        ? { awaitingMe: await (await import("@checkin/receipt")).receiptService.countAwaitingSubmitter(u.id) }
        : {},
  },
  {
    library: "income",
    visible: (u) => hasAnyRole(u, FINANCE_OR_BOARD),
    count: async (): Promise<Record<string, number>> =>
      process.env.INCOME_DATABASE_URL
        ? { openReconciliation: await (await import("@/lib/income/count")).incomeOpenCount() }
        : {},
  },
];

/**
 * Runs every provider the viewer may see, in parallel. A provider that throws
 * (e.g. its library DB is down) is logged and omitted, so it never breaks the
 * nav. Returns undefined when no provider produced counts.
 */
export async function collectLibraryCounts(
  user: SessionUser,
  releasedLibraries?: readonly string[] | null,
  providers: readonly LibraryCountProvider[] = LIBRARY_COUNT_PROVIDERS,
): Promise<LibraryCounts | undefined> {
  const viewer = { isBoardMember: user.isBoardMember, releasedLibraries };
  const results = await Promise.all(
    providers
      .filter((p) => isLibraryVisible(p.library, viewer) && p.visible(user))
      .map(async (p) => {
        try {
          return [p.library, await p.count(user)] as const;
        } catch (err) {
          console.error(`nav counts: ${p.library} provider failed`, err);
          return null;
        }
      }),
  );
  const libraries: LibraryCounts = {};
  for (const r of results) {
    if (r) libraries[r[0]] = { ...libraries[r[0]], ...r[1] };
  }
  return Object.keys(libraries).length > 0 ? libraries : undefined;
}
