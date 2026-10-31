import type { Session } from "next-auth";
import prisma from "@/lib/prisma";

export type ActivityMember = { id: number; name: string | null };

/**
 * Participants whose "my activities" a session may view: just the logged-in
 * user, or — for a household lead — every member of their household. Returns
 * {id, name} so callers can label whose activity a row belongs to.
 *
 * The lead check is the trust boundary for cross-member reads/writes; never
 * take a target participant id from the client without confirming it is in
 * this list (see {@link canActFor}).
 */
export async function activityMembers(session: Session): Promise<ActivityMember[]> {
    const selfId = session.user.id;
    if (!session.user.householdLead || !session.user.householdId) {
        return [{ id: selfId, name: session.user.name ?? null }];
    }
    return prisma.person.findMany({
        where: { householdId: session.user.householdId },
        select: { id: true, name: true },
        orderBy: { id: "asc" },
    });
}

/** True if the session may act for `participantId` (self, or household lead over them). */
export async function canActFor(session: Session, participantId: number): Promise<boolean> {
    if (session.user.id === participantId) return true;
    return (await activityMembers(session)).some(m => m.id === participantId);
}
