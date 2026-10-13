import { db } from "../db";

/** Two scalars for the Finance tab badges; no row data. */
export interface DonationNavCounts {
  unassignedQueue: number;
  disbursementHolds: number;
}

export async function getNavCounts(orgId: string): Promise<DonationNavCounts> {
  const [unassignedQueue, holdsDisbursements] = await Promise.all([
    db.transaction.count({ where: { orgId, ownerId: null, isOrganizationalLevel: false } }),
    db.disbursementHold.groupBy({ by: ["disbursementId"], where: { orgId, status: "PENDING" } }),
  ]);
  return { unassignedQueue, disbursementHolds: holdsDisbursements.length };
}
