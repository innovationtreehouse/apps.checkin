/**
 * Wire the bulk-donation library into checkin (#1280 §3/§6), called once at
 * server boot from instrumentation.ts. It shares the catalog's principal and
 * lazy Org-registry accessor, and binds the owner directory to checkin's
 * BudgetOwner table, read per call. Boot stays DB-free. The QuickBooks writer
 * and the in-kind ports (X9–X11, X13) stay unbound, so they are inert.
 */
import { configureBulkDonation } from "@inventory/bulk-donation";
import type { OwnerInfo } from "@inventory/bulk-donation";
import { getOrg, getPrincipal } from "@/lib/catalog/configure";

async function listOwners(): Promise<OwnerInfo[]> {
  const { default: prisma } = await import("@/lib/prisma");
  return prisma.budgetOwner.findMany({
    select: { id: true, name: true, archivedAt: true },
    orderBy: { name: "asc" },
  });
}

export function configureBulkDonationRuntime(): void {
  configureBulkDonation({ auth: { getPrincipal }, org: getOrg, owners: { list: listOwners } });
}
