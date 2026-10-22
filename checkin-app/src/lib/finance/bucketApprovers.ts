import prisma from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma/client";
import { LIVE_PERSON } from "@/lib/person/filters";

// Bucket-approver reads. This module imports no library package: the security
// gate calls it on every expense-approver check, and every route loads the gate.

/** A live person whose household is not DENIED: a denied household's roles grant nothing (assignParticipantClaims). Fresh per call, so no query shares it. */
export function eligibleSigner(): Prisma.PersonWhereInput {
    return { ...LIVE_PERSON, NOT: { household: { orgMembership: { status: "DENIED" } } } };
}

/** The live, non-org-level buckets this person owns or is a treasurer of. */
export async function bucketsApprovedBy(personId: number): Promise<number[]> {
    const rows = await prisma.budgetOwner.findMany({
        where: {
            isOrgLevel: false,
            archivedAt: null,
            OR: [
                { ownerId: personId, owner: eligibleSigner() },
                { treasurers: { some: { personId, person: eligibleSigner() } } },
            ],
        },
        select: { id: true },
    });
    return rows.map((r) => r.id);
}
