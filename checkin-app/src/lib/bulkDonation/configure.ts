/**
 * Wire the bulk-donation library into checkin (#1280 §3/§6), called once at
 * server boot from instrumentation.ts. It shares the catalog's principal and
 * lazy Org-registry accessor, and binds the owner directory to checkin's
 * BudgetOwner table, read per call. The no-receipt in-kind path's crossings are
 * bound in-process: the catalog lookup (X10) to the catalog's reads and the
 * inventory load (X11) to local-inventory's apply. The in-kind receipt callees
 * X9 and X13 are bound by their callers (workflow-mapping and receipt). Income
 * books and matches every Benevity deposit: donation hands each completed
 * disbursement to income's intake ports, and its own QuickBooks posting stays
 * unbound. A stop in the one-off move of donation's holdings alerts finance. The
 * in-kind drain books through checkin's one guarded client and reads its accounts
 * and Classes from the books map, bound wherever QBO_REALM_ID is set. The in-kind
 * accept step reads roles and bucket approvers through the expense library's
 * sign-off directory, households and surnames through donorSurname, and its
 * large-value warning through the expense library's capital review line threshold.
 * An accepted gift's lines go to the expense library's capital review, which
 * keeps donated equipment at or over its thresholds. Boot stays DB-free.
 */
import { IN_KIND_ROLES, configureBulkDonation, inKindAccountsReady } from "@checkin/bulk-donation";
import type { IncomeDeposits, InKindCapital, InKindDirectory, InKindQbPosting, OwnerInfo } from "@checkin/bulk-donation";
import { getOrg, getPrincipal } from "@/lib/catalog/configure";
import { catalogReader } from "@/lib/catalog/reader";
import { createLocalInventoryApply } from "@/lib/bulkDonation/inventoryApply";
import { householdMembersOf, householdsSharingSurname } from "@/lib/bulkDonation/donorSurname";
import { signoff } from "@/lib/expense/configure";
import { config } from "@/lib/config";
import { BOOKS_MAP_ROLE_LABELS } from "@/lib/finance/booksMapLabels";
import { escapeHtml } from "@/lib/email-templates/base";

async function listOwners(): Promise<OwnerInfo[]> {
  const { default: prisma } = await import("@/lib/prisma");
  return prisma.budgetOwner.findMany({
    select: { id: true, name: true, archivedAt: true, quickBooksClassId: true },
    orderBy: { name: "asc" },
  });
}

/** What handing Benevity deposits to income lacks, in plain words; empty when it binds. Income's books map holds the bank. */
export function donationPostingMissing(): string[] {
  return process.env.QBO_REALM_ID ? [] : ["QuickBooks company (QBO_REALM_ID)"];
}

/** Income's intake ports, loaded on first use so binding at boot stays DB-free. */
const incomeDeposits: IncomeDeposits = {
  prod: config.isProd(),
  async expectDeposit(orgId, disbursementId, expected) {
    return (await import("@checkin/income")).expectDeposit(orgId, "benevity", disbursementId, expected);
  },
  async depositStatus(orgId, disbursementIds) {
    return (await import("@checkin/income")).depositStatus(orgId, "benevity", disbursementIds);
  },
  async adoptHoldings(orgId, move) {
    return (await import("@checkin/income")).adoptBenevityDeposits(orgId, move);
  },
  async moveStopped({ cause }) {
    const { notifyFinanceAlert } = await import("@/lib/emailRecipients");
    await notifyFinanceAlert(
      "Donations: Benevity deposits could not be handed to income",
      `<p>Donation's QuickBooks holdings could not move to income, so no Benevity deposit is being matched or booked. The app retries daily. What stopped it: ${escapeHtml(cause)}</p><p><a href="${config.baseUrl()}/income/reconciliation">Open income's reconciliation queue</a></p>`,
      "Donation hand-over alert failed:",
    );
  },
};

/** What gift-of-goods posting lacks, in plain words; empty when the drain would run. Reads the books map as each run does. */
export async function inKindPostingMissing(): Promise<string[]> {
  const accounts = await (await import("@/lib/finance/booksMap")).booksMap.accounts();
  const unpicked = IN_KIND_ROLES.filter((r) => !accounts[r]);
  return [
    ...(process.env.QBO_REALM_ID ? [] : ["QuickBooks company (QBO_REALM_ID)"]),
    ...(unpicked.length ? [`no account picked for: ${unpicked.map((r) => BOOKS_MAP_ROLE_LABELS[r]).join(", ")}`] : []),
    ...(unpicked.length === 0 && !inKindAccountsReady(accounts) ? [`a ${BOOKS_MAP_ROLE_LABELS.INKIND_CLEARING} that no other lane books to`] : []),
  ];
}

/** Loaded on first use; the books map is read per run. */
function inKindQbPosting(): InKindQbPosting | undefined {
  if (!process.env.QBO_REALM_ID) return undefined;
  return {
    client: async () => (await import("@/lib/quickbooks/client")).getQuickBooks(),
    booksMap: {
      accounts: async () => (await import("@/lib/finance/booksMap")).booksMap.accounts(),
      classes: async () => (await import("@/lib/finance/booksMap")).booksMap.classes(),
    },
    async sweepIncomplete({ since }) {
      const { notifyFinanceAlert } = await import("@/lib/emailRecipients");
      await notifyFinanceAlert(
        "Gifts of goods: the daily check for stray QuickBooks journal entries could not see them all",
        `<p>QuickBooks returned more journal entries created since ${since.toISOString().slice(0, 10)} than the daily check reads at once, so a journal entry the app created for a gift of goods may sit in QuickBooks unlinked. Check recent journal entries that carry a checkin key in their memo. <a href="${config.baseUrl()}/donations/in-kind">Open the in-kind queue</a></p>`,
        "In-kind sweep alert failed:",
      );
    },
  };
}

async function incomeClaimedDepositIds(orgId: string): Promise<string[]> {
  return (await import("@checkin/income")).incomeClaimedDepositIds(orgId);
}

const inKind: InKindDirectory = {
  financeHolders: signoff.financeHolders,
  boardMembers: signoff.boardMembers,
  async householdsOf(personIds) {
    const { default: prisma } = await import("@/lib/prisma");
    return householdMembersOf(prisma, personIds);
  },
  async householdsSharingSurname(checks) {
    const { default: prisma } = await import("@/lib/prisma");
    return householdsSharingSurname(prisma, checks);
  },
  bucketsApprovedBy: signoff.bucketsApprovedBy,
  async largeValueCents() {
    const { getExpenseSettings } = await import("@checkin/expense");
    return (await getExpenseSettings((await getOrg()).id)).capitalLineItemThresholdCents;
  },
};

const capital: InKindCapital = {
  async submit(orgId, lines) {
    await (await import("@checkin/expense")).submitDonatedLines(orgId, lines);
  },
  async awaitingReview(orgId) {
    return (await import("@checkin/expense")).giftsAwaitingCapitalReview(orgId);
  },
  async assetLineIds(orgId, gift) {
    return (await import("@checkin/expense")).donatedAssetLineIds(orgId, gift);
  },
};

export function configureRuntime(): void {
  configureBulkDonation({
    auth: { getPrincipal },
    org: getOrg,
    owners: { list: listOwners },
    catalog: { search: catalogReader.searchItems, getItem: catalogReader.getItem },
    inventory: createLocalInventoryApply(getOrg),
    inKindQb: inKindQbPosting(),
    deposits: incomeDeposits,
    otherLaneClaims: { claimedDepositIds: incomeClaimedDepositIds },
    inKind,
    capital,
  });
}
