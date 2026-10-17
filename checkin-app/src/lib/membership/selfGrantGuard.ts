import type { Prisma } from "@/generated/prisma/client";
import type { DbClient } from "@/lib/db-client";
import { resolveActorHouseholdId, sharesHousehold } from "@/lib/conflictOfInterest";
import { canonicalizeEmail } from "@/lib/emailNormalize";
import { LIVE_PERSON } from "@/lib/person/filters";

/**
 * The one own-household check for grants that discount the membership fee, clear a person, or
 * confer volunteer standing: the household volunteer flag, a volunteer designation,
 * a background-check date, a program volunteer row or its core flag, plus acting
 * on a payment problem. Every writer of one of these calls it (selfGrantGuard.test.ts
 * enforces that). Setting a tool certification level calls it too.
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
export type GrantAttempt = { table: "Person" | "OrgMembership" | "VolunteerDesignation" | "PaymentException" | "ProgramVolunteer" | "ToolStatus"; attempted: Prisma.InputJsonObject };

export const SELF_GRANT_REFUSAL_TABLE = "SelfGrantRefusal";

export const SELF_GRANT_REFUSAL_MESSAGE =
    "You cannot grant this to yourself or your own household — someone outside your household must.";

/** A refused grant, as its audit row records it. */
export type SelfGrantRefusal = { actorId: number; affectedEntityId: number; newData: Prisma.InputJsonObject };

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
    const refusal = await findSelfGrantRefusal(db, actorId, subject, attempt);
    if (refusal) await recordSelfGrantRefusal(db, refusal);
    return refusal !== null;
}

/**
 * The refusal for this grant, or null when it may proceed. Writes nothing, so a
 * caller inside a transaction can throw it out and record it after the rollback.
 */
export async function findSelfGrantRefusal(
    db: DbClient,
    actorId: number,
    subject: GrantSubject,
    attempt: GrantAttempt,
): Promise<SelfGrantRefusal | null> {
    const actorHouseholdId = await resolveActorHouseholdId(db, actorId);

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

    if (reason === null) return null;
    return { actorId, affectedEntityId, newData: { reason, table: attempt.table, subject, attempted: attempt.attempted } };
}

/** Writes a refusal's audit row under `SELF_GRANT_REFUSAL_TABLE`. */
export async function recordSelfGrantRefusal(db: DbClient, refusal: SelfGrantRefusal): Promise<void> {
    await db.auditLog.create({ data: { ...refusal, action: "EDIT", tableName: SELF_GRANT_REFUSAL_TABLE } });
}

/** The id of the person in the actor's household whose email is `email` (canonical), or null. */
async function ownHouseholdEmailMatch(db: DbClient, householdId: number, email: string): Promise<number | null> {
    const canonical = canonicalizeEmail(email);
    const members = await db.person.findMany({ where: { householdId, ...LIVE_PERSON }, select: { id: true, email: true } });
    return members.find((p) => p.email != null && canonicalizeEmail(p.email) === canonical)?.id ?? null;
}
