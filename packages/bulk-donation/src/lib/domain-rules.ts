/**
 * Single home for disbursement business rules.
 */

/**
 * A transaction with no donor comment is auto-classified as organizational-level
 * (no individual owner required).
 */
export function isAutoOrganizationalLevel(donorComment: string | null | undefined): boolean {
  return !donorComment || donorComment.trim() === "";
}

/**
 * Prisma where clause for transactions that still require an owner assignment:
 * within the org, owner not set, and not organizational-level. Canonical
 * definition of "blocks readiness" / "unassigned queue".
 */
export function ownerRequiredWhere(orgId: string) {
  return { orgId, ownerId: null as null, isOrganizationalLevel: false };
}

/** True if a transaction is finalized for ownership (owner set or org-level). */
export function isOwnershipFinalized(tx: { ownerId: number | null; isOrganizationalLevel: boolean }): boolean {
  return tx.ownerId !== null || tx.isOrganizationalLevel;
}
