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
 * "unbound". Deposits income holds are kept out of its matching. The in-kind
 * accept step reads roles, households and bucket approvers through the expense
 * library's sign-off directory, and its large-value warning through the expense
 * library's capital-equipment amount. Boot stays DB-free.
 */
import { configureBulkDonation } from "@checkin/bulk-donation";
import type { DonationQbPosting, InKindDirectory, OwnerInfo } from "@checkin/bulk-donation";
import { getOrg, getPrincipal } from "@/lib/catalog/configure";
import { catalogReader } from "@/lib/catalog/reader";
import { createLocalInventoryApply } from "@/lib/bulkDonation/inventoryApply";
import { householdSharesSurname } from "@/lib/bulkDonation/donorSelfGuard";
import { signoff } from "@/lib/expense/configure";
import { config } from "@/lib/config";

async function listOwners(): Promise<OwnerInfo[]> {
  const { default: prisma } = await import("@/lib/prisma");
  return prisma.budgetOwner.findMany({
    select: { id: true, name: true, archivedAt: true, quickBooksClassId: true },
    orderBy: { name: "asc" },
  });
}

/** Loaded on first use, so binding at boot pulls in no AWS SDK. */
function qbPosting(): DonationQbPosting | undefined {
  const bankAccountId = process.env.QBO_DONATION_BANK_ACCOUNT_ID;
  if (!process.env.QBO_REALM_ID || !bankAccountId) return undefined;
  return {
    client: async () => (await import("@/lib/quickbooks/client")).getQuickBooks(),
    bankAccountId,
    prod: config.isProd(),
  };
}

async function incomeClaimedDepositIds(orgId: string): Promise<string[]> {
  return (await import("@checkin/income")).incomeClaimedDepositIds(orgId);
}

const inKind: InKindDirectory = {
  financeHolders: signoff.financeHolders,
  boardMembers: signoff.boardMembers,
  householdOf: async (personIds) => [...new Set([...personIds, ...(await signoff.householdOf(personIds))])],
  async householdSharesSurname(personId, lastName) {
    const { default: prisma } = await import("@/lib/prisma");
    return householdSharesSurname(prisma, personId, lastName);
  },
  bucketsApprovedBy: signoff.bucketsApprovedBy,
  async largeValueCents() {
    const { getExpenseSettings } = await import("@checkin/expense");
    return (await getExpenseSettings((await getOrg()).id)).capitalEquipmentUnitCents;
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
  });
}
