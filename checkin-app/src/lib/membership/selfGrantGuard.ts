import type { Prisma } from "@/generated/prisma/client";
import type { DbClient } from "@/lib/db-client";
import { sharesHousehold } from "@/lib/conflictOfInterest";
import { canonicalizeEmail } from "@/lib/emailNormalize";
import { LIVE_PERSON } from "@/lib/person/filters";

/**
 * The one own-household check for grants that discount dues or clear a person:
 * the household volunteer flag, a volunteer designation, and a background-check
 * date. Every route that writes one of these calls it (selfGrantGuard.test.ts
 * enforces that).
 *
 * Refuses when the subject is the actor or shares the actor's household, and when
 * the actor's household can't be resolved (fail closed). No role is exempt. Every
 * refusal writes an audit row under `SELF_GRANT_REFUSAL_TABLE`, kept apart from the
 * granted table so a refused attempt never reads as an edit of that row.
 */

/** Who a grant lands on. An email is matched, canonically, against the actor's household. */
export type GrantSubject =
    | { personId: number; householdId: number | null }
    | { householdId: number }
    | { email: string };

/** What the actor tried: the table the grant writes and the fields it would have set. */
export type GrantAttempt = { table: "Person" | "OrgMembership" | "VolunteerDesignation"; attempted: Prisma.InputJsonObject };

export const SELF_GRANT_REFUSAL_TABLE = "SelfGrantRefusal";

export const SELF_GRANT_REFUSAL_MESSAGE =
    "You cannot grant this to yourself or your own household — someone outside your household must.";

/**
 * Whether the grant is refused. Writes the refusal's audit row when it is; the
 * caller returns 403 and writes nothing else.
 */
export async function refuseSelfGrant(
    db: DbClient,
    actorId: number,
    subject: GrantSubject,
    attempt: GrantAttempt,
): Promise<boolean> {
    // ponytail: same fail-closed lookup as #1888's resolveActorHouseholdId; switch to it once both land.
    const actor = await db.person.findUnique({ where: { id: actorId }, select: { householdId: true } });
    const actorHouseholdId = actor?.householdId ?? null;

    let reason: "actor_household_unresolved" | "own_household" | null = null;
    let affectedEntityId = actorId;
    if (actorHouseholdId === null) {
        reason = "actor_household_unresolved";
    } else if ("email" in subject) {
        const match = await ownHouseholdEmailMatch(db, actorHouseholdId, subject.email);
        if (match !== null) {
            reason = "own_household";
            affectedEntityId = match;
        }
    } else if ("personId" in subject) {
        affectedEntityId = subject.personId;
        if (subject.personId === actorId || sharesHousehold(actorHouseholdId, subject.householdId)) reason = "own_household";
    } else {
        affectedEntityId = subject.householdId;
        if (sharesHousehold(actorHouseholdId, subject.householdId)) reason = "own_household";
    }

    if (reason === null) return false;

    await db.auditLog.create({
        data: {
            actorId,
            action: "EDIT",
            tableName: SELF_GRANT_REFUSAL_TABLE,
            affectedEntityId,
            newData: { reason, table: attempt.table, subject, attempted: attempt.attempted },
        },
    });
    return true;
}

/** The id of the person in the actor's household whose email is `email` (canonical), or null. */
async function ownHouseholdEmailMatch(db: DbClient, householdId: number, email: string): Promise<number | null> {
    const canonical = canonicalizeEmail(email);
    const members = await db.person.findMany({ where: { householdId, ...LIVE_PERSON }, select: { id: true, email: true } });
    return members.find((p) => p.email != null && canonicalizeEmail(p.email) === canonical)?.id ?? null;
}
