/**
 * Wire the bulk-donation library into checkin (#1280 §3/§6), called once at
 * server boot from instrumentation.ts. It shares the catalog's principal and
 * lazy Org-registry accessor, and binds the owner directory to checkin's
 * BudgetOwner table, read per call. The no-receipt in-kind path's crossings are
 * bound in-process: the catalog lookup (X10) to the catalog's reads and the
 * inventory load (X11) to local-inventory's apply. The in-kind receipt callees
 * X9 and X13 are bound by their callers (workflow-mapping and receipt). Boot
 * stays DB-free. The QuickBooks writer stays unbound, so it is inert.
 */
import { configureBulkDonation } from "@inventory/bulk-donation";
import type { OwnerInfo } from "@inventory/bulk-donation";
import { getOrg, getPrincipal } from "@/lib/catalog/configure";
import { catalogReader } from "@/lib/catalog/reader";
import { createLocalInventoryApply } from "@/lib/bulkDonation/inventoryApply";

async function listOwners(): Promise<OwnerInfo[]> {
  const { default: prisma } = await import("@/lib/prisma");
  return prisma.budgetOwner.findMany({
    select: { id: true, name: true, archivedAt: true },
    orderBy: { name: "asc" },
  });
}

export function configureRuntime(): void {
  configureBulkDonation({
    auth: { getPrincipal },
    org: getOrg,
    owners: { list: listOwners },
    catalog: { search: catalogReader.searchItems, getItem: catalogReader.getItem },
    inventory: createLocalInventoryApply(getOrg),
  });
}
