import { settleCounts } from "@checkin/component-kit";
import { db } from "../db";

/** Two scalars for the Finance tab badges; no row data. A failed count is left out. */
export type DonationNavCounts = Partial<Record<"unassignedQueue" | "disbursementHolds", number>>;

export async function getNavCounts(orgId: string): Promise<DonationNavCounts> {
  return settleCounts("bulk-donation", {
    unassignedQueue: () => db.transaction.count({ where: { orgId, ownerId: null, isOrganizationalLevel: false } }),
    disbursementHolds: async () =>
      (await db.disbursementHold.groupBy({ by: ["disbursementId"], where: { orgId, status: "PENDING" } })).length,
  });
}
