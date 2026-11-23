import type { Prisma } from "@/generated/prisma/client";
import type { DbClient } from "@/lib/db-client";

/**
 * A valid emergency contact: a name and a phone, not flagged as a household member.
 * The database stores name and phone trimmed (CHECK constraints on EmergencyContact),
 * so non-empty here means non-blank, and the where-fragment and predicate agree exactly.
 */
export const VALID_CONTACT_WHERE = {
    conflictParticipantId: null,
    name: { not: "" },
    phone: { not: "" },
} satisfies Prisma.EmergencyContactWhereInput;

export function isValidContact(c: { name: string; phone: string; conflictParticipantId: number | null }): boolean {
    return c.conflictParticipantId === null && c.name !== "" && c.phone !== "";
}

export async function householdHasValidContact(db: DbClient, householdId: number): Promise<boolean> {
    const count = await db.emergencyContact.count({ where: { householdId, ...VALID_CONTACT_WHERE } });
    return count > 0;
}
