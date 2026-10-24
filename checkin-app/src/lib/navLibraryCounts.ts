/**
 * Per-library nav pill counts for /api/nav/todo-counts. A library wiring PR
 * registers one provider in LIBRARY_COUNT_PROVIDERS; its counts reach the
 * client as `counts.libraries[library]`, read by badge functions via
 * navBadges' libraryCount().
 */
import type { SessionUser } from "@/types/auth";
import { isLibraryVisible, type LibraryKey } from "@/lib/libraryRelease";
import { canSubmitReceipts } from "@/lib/volunteer";
import { financeQueueCountKey } from "@checkin/receipt/nav";

export type LibraryCounts = Partial<Record<LibraryKey, Record<string, number>>>;

export type LibraryCountProvider = {
  library: LibraryKey;
  /** Whether this viewer gets the counts: only a role that can act on what they count. */
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
    // Only FINANCE assigns a gift or resubmits a disbursement hold.
    visible: (u) => u.isFinance === true,
    count: async (): Promise<Record<string, number>> => {
      if (!process.env.BULK_DONATION_DATABASE_URL) return {};
      const { getNavCounts, getOrgId } = await import("@checkin/bulk-donation");
      const { unassignedQueue, disbursementHolds } = await getNavCounts(await getOrgId());
      return { unassignedQueue, disbursementHolds };
    },
  },
  {
    library: "workflow-mapping",
    // Only INVENTORY_MANAGER maps or applies a receipt.
    visible: (u) => u.isInventoryManager === true,
    count: async () =>
      process.env.WORKFLOW_MAPPING_DATABASE_URL ? (await import("@checkin/workflow-mapping")).receiptService.counts() : {},
  },
  {
    library: "local-inventory",
    // Only INVENTORY_MANAGER fulfils or cancels a queued line; FINANCE and BOARD only read the queue.
    visible: (u) => u.isInventoryManager === true,
    count: async (): Promise<Record<string, number>> =>
      process.env.LOCAL_INVENTORY_DATABASE_URL ? (await import("@checkin/local-inventory")).getNavCounts() : {},
  },
  {
    library: "income",
    // Only FINANCE runs and resolves reconciliation.
    visible: (u) => u.isFinance === true,
    count: async (): Promise<Record<string, number>> =>
      process.env.INCOME_DATABASE_URL
        ? { openReconciliation: await (await import("@/lib/income/count")).incomeOpenCount() }
        : {},
  },
  {
    library: "receipt",
    // An uploader counts their own receipts; anyone who may be named as reimbursee (an adult) counts
    // the confirmations waiting on them, and a Board member also those it alone gives, for a
    // reimbursee with no account. FINANCE counts its queues, less the receipts it is conflicted on;
    // BOARD reads the queues but cannot act on them, so it gets no queue count.
    visible: (u) => canSubmitReceipts(u) || u.ageBand === "adult" || u.isFinance === true || u.isBoardMember === true,
    count: async (u): Promise<Record<string, number>> => {
      if (!process.env.RECEIPT_DATABASE_URL || typeof u.id !== "number") return {};
      const { receiptService } = await import("@checkin/receipt");
      const board = u.isBoardMember === true;
      const [awaitingMe, toConfirm, finance] = await Promise.all([
        canSubmitReceipts(u) ? receiptService.countAwaitingSubmitter(u.id) : null,
        u.ageBand === "adult" || board ? receiptService.countToConfirm(u.id, board) : null,
        u.isFinance === true ? receiptService.countAwaitingFinance(u.id) : null,
      ]);
      return {
        ...(awaitingMe === null ? {} : { awaitingMe }),
        ...(toConfirm === null ? {} : { toConfirm }),
        ...(finance === null
          ? {}
          : {
              awaitingFinance: finance.total,
              ...Object.fromEntries(Object.entries(finance.byState).map(([state, n]) => [financeQueueCountKey(state), n])),
            }),
      };
    },
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
