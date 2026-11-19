import type { TxClient } from "@/lib/db-client";

/*
 * The one row-lock order every membership and program transaction takes, so no two
 * of them wait on each other in a cycle:
 *
 *   Program → BOARD role rows → OrgMembership → Household → Person → OrgMembershipProcess / TrustedAdult
 *
 * Each set is locked by ascending id. A path that already holds the OrgMembership
 * or Person rows a process belongs to may lock that process after its own, in any
 * order. A path that starts from a process reads it without a lock, takes the locks
 * in this order, then re-reads and refuses if what it read has changed.
 */

/** Person rows FOR UPDATE, by ascending id. */
export async function lockPersonRows(tx: TxClient, ids: readonly (number | null)[]): Promise<void> {
    for (const id of sortedIds(ids)) await tx.$queryRaw`SELECT id FROM "Person" WHERE id = ${id} FOR UPDATE`;
}

/** OrgMembershipProcess rows FOR UPDATE, by ascending id. */
export async function lockProcessRows(tx: TxClient, ids: readonly (number | null)[]): Promise<void> {
    for (const id of sortedIds(ids)) await tx.$queryRaw`SELECT id FROM "OrgMembershipProcess" WHERE id = ${id} FOR UPDATE`;
}

function sortedIds(ids: readonly (number | null)[]): number[] {
    return [...new Set(ids.filter((id): id is number => id !== null))].sort((a, b) => a - b);
}
