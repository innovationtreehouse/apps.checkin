import type { DbClient } from "@/lib/db-client";

/**
 * Conflict-of-interest primitives, shared by every self-approval gate.
 *
 * The policy is uniform across the app: an actor may not approve, certify, clear,
 * or grant something for their OWN household — approving your own family is the
 * same abuse whether it's a background-check review, membership dues, a program
 * payment plan, or a direct membership grant.
 *
 * No role is exempt. `isSysadmin` is an application role with no counterpart in the
 * org's policy corpus, so it cannot stand in for the non-conflicted board member the
 * policy requires — a sysadmin who is also board is bound by this rule like anyone
 * else. Don't add a role-shaped parameter here; a break-glass path needs its own
 * audited, multi-actor mechanism, not a flag that silently returns false.
 *
 * Two entry points, because callers differ in what they already hold:
 *   - sharesHousehold(a, b): pure predicate for callers that already have both
 *     household ids loaded (attest's already-loaded reviewer, isTrustedAdultConflict,
 *     the UI gating its buttons off the same rule so client and server can't drift).
 *   - hasHouseholdConflict(db, actorId, subjectHouseholdId): resolves the actor's
 *     household itself, for callers that only hold an actor id (the service/route
 *     guards).
 *
 * What is deliberately NOT here: resolving the SUBJECT's household. That varies per
 * caller (a person, an OrgMembership, an OrgMembershipProcess, or a raw householdId
 * param) and folding it in would be a bigger discriminated-union resolver than the
 * duplication it removes. Each caller resolves its own subject household — it already
 * has the row loaded — and passes the scalar in.
 */

/** The core rule: an actor conflicts with a subject when they share a (non-null) household. */
export function sharesHousehold(
    actorHouseholdId: number | null | undefined,
    subjectHouseholdId: number | null | undefined,
): boolean {
    return actorHouseholdId != null && actorHouseholdId === subjectHouseholdId;
}

/**
 * The actor's household, or null when the actor id is not a positive integer or
 * resolves to nobody. Callers treat null as "refuse" (fail closed).
 */
export async function resolveActorHouseholdId(db: DbClient, actorId: unknown): Promise<number | null> {
    if (typeof actorId !== "number" || !Number.isInteger(actorId) || actorId <= 0) return null;
    const actor = await db.person.findUnique({ where: { id: actorId }, select: { householdId: true } });
    return actor?.householdId ?? null;
}

/**
 * Whether `actorId` has a household conflict with a subject in `subjectHouseholdId`.
 * Resolves the actor's household so callers don't re-roll the same findUnique.
 * Returns false (no conflict) only when the subject has no household to conflict with.
 */
export async function hasHouseholdConflict(
    db: DbClient,
    actorId: number,
    subjectHouseholdId: number | null | undefined,
): Promise<boolean> {
    if (subjectHouseholdId == null) return false;
    const actor = await db.person.findUnique({ where: { id: actorId }, select: { householdId: true } });
    return sharesHousehold(actor?.householdId, subjectHouseholdId);
}
