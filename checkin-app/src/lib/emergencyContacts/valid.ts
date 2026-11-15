import type { DbClient } from "@/lib/db-client";

/** A household has a valid emergency contact: a name and a phone, not flagged as a household member. */
export async function householdHasValidContact(db: DbClient, householdId: number): Promise<boolean> {
    const count = await db.emergencyContact.count({
        where: { householdId, conflictParticipantId: null, name: { not: "" }, phone: { not: "" } },
    });
    return count > 0;
}
