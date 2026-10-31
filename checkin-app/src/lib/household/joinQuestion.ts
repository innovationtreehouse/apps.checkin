import prisma from "@/lib/prisma";
import type { DbClient } from "@/lib/db-client";
import { LIVE_PERSON } from "@/lib/person/filters";
import { nameWrite } from "@/lib/person/name";
import { createInOwnHousehold } from "@/lib/person/ownHousehold";
import { lockAndFindDeniedHousehold } from "@/lib/membership/householdStatus";
import { isYouth } from "@/lib/time";

export type JoinRefusal = "not_pending" | "youth" | "denied";

export class JoinQuestionError extends Error {
    constructor(public readonly refusal: JoinRefusal) {
        super(refusal);
        this.name = "JoinQuestionError";
    }
}

/**
 * Whether an account about to be linked is this record's first, on an adult, in a household
 * where someone else has signed in: that someone is who added them, so they are asked.
 * A youth stays where they were added. A record nobody has signed in beside is theirs to claim.
 */
export async function asksHouseholdQuestion(db: DbClient, personId: number): Promise<boolean> {
    const person = await db.person.findUnique({
        where: { id: personId },
        select: { householdId: true, dateOfBirth: true, _count: { select: { accounts: true } } },
    });
    if (!person || person._count.accounts > 0 || isYouth(person.dateOfBirth)) return false;
    const peer = await db.person.findFirst({
        where: { householdId: person.householdId, id: { not: personId }, accounts: { some: {} }, ...LIVE_PERSON },
        select: { id: true },
    });
    return peer !== null;
}

/** The household's name is all the question shows: nothing of the record that carries the address. */
export async function householdQuestion(personId: number): Promise<{ householdName: string | null }> {
    const person = await prisma.person.findUnique({
        where: { id: personId },
        select: { householdJoinPending: true, household: { select: { name: true } } },
    });
    if (!person?.householdJoinPending) throw new JoinQuestionError("not_pending");
    return { householdName: person.household.name };
}

// The address's holder may not be whoever the household meant, so a no carries nothing over.
function nameFromIdToken(idToken: string | null | undefined): string | undefined {
    try {
        return nameWrite(JSON.parse(Buffer.from(idToken?.split(".")[1] ?? "", "base64url").toString()).name);
    } catch {
        return undefined;
    }
}

/**
 * Yes leaves them where they are. No leaves the record in the household without the address
 * and moves the account to a new empty person, who signs in afresh: the old session's email
 * no longer matches its record, so the jwt callback ends it.
 */
export async function answerHouseholdQuestion(personId: number, join: boolean): Promise<void> {
    await prisma.$transaction(async (tx) => {
        const person = await tx.person.findUnique({
            where: { id: personId },
            select: { householdId: true, email: true, dateOfBirth: true, householdJoinPending: true, mergedIntoId: true },
        });
        if (!person?.householdJoinPending || person.mergedIntoId !== null || !person.email) {
            throw new JoinQuestionError("not_pending");
        }
        if (isYouth(person.dateOfBirth)) throw new JoinQuestionError("youth");
        if (await lockAndFindDeniedHousehold(tx, [person.householdId]) !== null) {
            throw new JoinQuestionError("denied");
        }

        if (join) {
            await tx.person.update({ where: { id: personId }, data: { householdJoinPending: false } });
            await tx.auditLog.create({
                data: {
                    actorId: personId,
                    action: "EDIT",
                    tableName: "Person",
                    affectedEntityId: personId,
                    newData: { householdQuestion: "yes", householdId: person.householdId },
                },
            });
            return;
        }

        const account = await tx.account.findFirst({ where: { userId: personId }, select: { id_token: true } });
        // Cleared first: Person.email is unique and the new person takes it.
        await tx.person.update({
            where: { id: personId },
            data: { householdJoinPending: false, email: null, emailVerified: null, googleId: null, image: null },
        });
        const fresh = await createInOwnHousehold(tx, {
            email: person.email,
            name: nameFromIdToken(account?.id_token) ?? nameWrite(person.email.split("@")[0]) ?? "Member",
        });
        await tx.account.updateMany({ where: { userId: personId }, data: { userId: fresh.id } });
        await tx.auditLog.create({
            data: {
                actorId: fresh.id,
                action: "EDIT",
                tableName: "Person",
                affectedEntityId: personId,
                secondaryAffectedEntity: person.householdId,
                newData: { householdQuestion: "no", accountMovedTo: fresh.id },
            },
        });
    });
}
