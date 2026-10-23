import prisma from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma/client";
import { LIVE_PERSON } from "@/lib/person/filters";

// Bucket-approver reads. This module imports no library package: the security
// gate calls it on every expense-approver check, and every route loads the gate.

/** A live person whose household is not DENIED: a denied household's roles grant nothing (assignParticipantClaims). */
export const ELIGIBLE_SIGNER: Prisma.PersonWhereInput = {
    ...LIVE_PERSON,
    NOT: { household: { orgMembership: { status: "DENIED" } } },
};

/** The buckets this person approves: those of the programs they lead or are a treasurer of. */
export async function bucketsApprovedBy(personId: number): Promise<number[]> {
    const rows = await prisma.budgetOwner.findMany({
        where: {
            program: {
                OR: [
                    { leadMentorId: personId, leadMentor: ELIGIBLE_SIGNER },
                    { volunteers: { some: { personId, isTreasurer: true, person: ELIGIBLE_SIGNER } } },
                ],
            },
        },
        select: { id: true },
    });
    return rows.map((r) => r.id);
}
