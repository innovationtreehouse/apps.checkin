import prisma from "@/lib/prisma";
import { ageBand } from "@/lib/programAge";

/**
 * Whether a non-staff viewer may see the payment status (paid / not paid yet) of
 * their own household's enrollments. Only a household lead who is a known adult;
 * everyone else — a youth, a lead of unknown age, a non-lead household member —
 * sees none, and no family ever sees another household's.
 *
 * Read from the DB, not the session claims: a lead change must take effect before
 * the session re-syncs.
 */
export async function seesHouseholdPaymentStatus(personId: number): Promise<boolean> {
    return (await householdPaymentViewer(personId)) !== null;
}

/** {@link seesHouseholdPaymentStatus}, with the household whose payment status the viewer sees; null when they see none. */
export async function householdPaymentViewer(personId: number): Promise<{ householdId: number } | null> {
    const lead = await prisma.person.findFirst({
        where: { id: personId, isHouseholdLead: true },
        select: { dateOfBirth: true, isDeclaredAdult: true, householdId: true },
    });
    return lead && ageBand(lead) === "adult" ? { householdId: lead.householdId } : null;
}
