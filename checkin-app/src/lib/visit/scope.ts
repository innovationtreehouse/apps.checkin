import prisma from "@/lib/prisma";
import { householdLeadship } from "@/lib/household/leads";
import { LIVE_PERSON } from "@/lib/person/filters";

export type VisitSubject = { id: number; isKeyholder: boolean };

/**
 * Resolve who the actor may write visits for on the self-service surface
 * (docs/rules/attendance-checkin.md): themselves always, and
 * — for a household lead — any member of their OWN household. The lead is the
 * responsible adult, so acting for a household member is self-equivalent; this
 * is the only way a minor's visit can be corrected at all.
 *
 * The scope comes from the server (the actor's own householdId), never from the
 * request: a subjectId off the body is only ever a target to check against it.
 * Returns null when the actor has no such claim — the caller turns that into a
 * 403 (an explicit target) or a 404 (a target reached through a visit id).
 */
export async function visitSubject(actorId: number, subjectId: number): Promise<VisitSubject | null> {
    const subject = await prisma.person.findFirst({
        where: { id: subjectId, ...LIVE_PERSON },
        select: { id: true, isKeyholder: true, householdId: true },
    });
    if (!subject) return null;
    if (actorId === subjectId) return subject;

    const lead = await householdLeadship(actorId);
    if (!lead?.canManage || lead.householdId !== subject.householdId) return null;
    return subject;
}
