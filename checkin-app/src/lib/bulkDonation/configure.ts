/**
 * Wire the bulk-donation library into checkin (#1280 §3/§6), called once at
 * server boot from instrumentation.ts. It shares the catalog's principal and
 * lazy Org-registry accessor, and binds the owner directory to checkin's
 * BudgetOwner table, read per call. The no-receipt in-kind path's crossings are
 * bound in-process: the catalog lookup (X10) to the catalog's reads and the
 * inventory load (X11) to local-inventory's apply. The in-kind receipt callees
 * X9 and X13 are bound by their callers (workflow-mapping and receipt). The
 * QuickBooks drain books through checkin's one guarded client, bound only where
 * QBO_REALM_ID and QBO_DONATION_BANK_ACCOUNT_ID are set; unbound, a run answers
 * "unbound"; a daily sweep that could not read every Deposit alerts finance. Deposits income
 * holds are kept out of its matching. The in-kind
 * accept step reads roles and bucket approvers through the expense library's
 * sign-off directory, households and surnames through donorSurname, and its
 * large-value warning through the expense library's capital review line threshold.
 * An accepted gift's lines go to the expense library's capital review, which
 * keeps donated equipment at or over its thresholds. Boot stays DB-free.
 */
import { configureBulkDonation } from "@checkin/bulk-donation";
import type { DonationQbPosting, InKindCapital, InKindDirectory, OwnerInfo } from "@checkin/bulk-donation";
import { getOrg, getPrincipal } from "@/lib/catalog/configure";
import { catalogReader } from "@/lib/catalog/reader";
import { createLocalInventoryApply } from "@/lib/bulkDonation/inventoryApply";
import { householdMembersOf, householdsSharingSurname } from "@/lib/bulkDonation/donorSurname";
import { signoff } from "@/lib/expense/configure";
import { config } from "@/lib/config";

async function listOwners(): Promise<OwnerInfo[]> {
  const { default: prisma } = await import("@/lib/prisma");
  return prisma.budgetOwner.findMany({
    select: { id: true, name: true, archivedAt: true, quickBooksClassId: true },
    orderBy: { name: "asc" },
  });
}

/** What donation posting lacks, in plain words; empty when it binds. */
export function donationPostingMissing(): string[] {
  return [
    ...(process.env.QBO_REALM_ID ? [] : ["QuickBooks company (QBO_REALM_ID)"]),
    ...(process.env.QBO_DONATION_BANK_ACCOUNT_ID ? [] : ["bank account (QBO_DONATION_BANK_ACCOUNT_ID)"]),
  ];
}

/** Loaded on first use, so binding at boot pulls in no AWS SDK. */
function qbPosting(): DonationQbPosting | undefined {
  const bankAccountId = process.env.QBO_DONATION_BANK_ACCOUNT_ID;
  if (donationPostingMissing().length > 0 || !bankAccountId) return undefined;
  return {
    client: async () => (await import("@/lib/quickbooks/client")).getQuickBooks(),
    bankAccountId,
    prod: config.isProd(),
    async sweepIncomplete({ since }) {
      const { notifyFinanceAlert } = await import("@/lib/emailRecipients");
      await notifyFinanceAlert(
        "Donations: the daily check for stray QuickBooks deposits could not see them all",
        `<p>QuickBooks returned more deposits created since ${since.toISOString().slice(0, 10)} than the daily check reads at once, so a deposit the app created may sit in QuickBooks unlinked. Check recent deposits that carry a checkin key in their memo. <a href="${config.baseUrl()}/donations/qb-queue">Open the donations QuickBooks queue</a></p>`,
        "Donation sweep alert failed:",
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
};

export function configureRuntime(): void {
  configureBulkDonation({
    auth: { getPrincipal },
    org: getOrg,
    owners: { list: listOwners },
    catalog: { search: catalogReader.searchItems, getItem: catalogReader.getItem },
    inventory: createLocalInventoryApply(getOrg),
    qb: qbPosting(),
    otherLaneClaims: { claimedDepositIds: incomeClaimedDepositIds },
    inKind,
    capital,
  });
}
