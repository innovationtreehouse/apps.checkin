import { NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import type { Session } from "next-auth";
import { withAuth } from "@/lib/auth";
import prisma from "@/lib/prisma";
import { activityMembers } from "@/lib/household/activityMembers";
import { apiError } from "@/lib/api-response";

export const GET = withAuth({}, async (_req, auth) => {
    if (auth.type !== 'session') return apiError("Unauthorized", 401);
    // activityMembers only reads session.user; reconstruct the minimal shape from auth.user.
    const session = { user: auth.user } as unknown as Session;

    try {
        // Self, or every household member when the session is a household lead.
        const householdMembers = await activityMembers(session);
        const householdMemberIds = householdMembers.map(m => m.id);
        const householdMemberById = new Map(householdMembers.map(m => [m.id, m]));

        // Which household members are tied to which programs (enrolled, volunteering, or leading).
        const [enrolled, volunteers, ledPrograms] = await Promise.all([
            prisma.programParticipant.findMany({
                where: { personId: { in: householdMemberIds } },
                select: { personId: true, programId: true }
            }),
            prisma.programVolunteer.findMany({
                where: { personId: { in: householdMemberIds } },
                select: { personId: true, programId: true }
            }),
            prisma.program.findMany({
                where: { leadMentorId: { in: householdMemberIds } },
                select: { id: true, leadMentorId: true }
            })
        ]);
        const led = ledPrograms.map(p => ({ personId: p.leadMentorId as number, programId: p.id }));

        const programParticipants = new Map<number, Set<number>>();
        for (const { programId, personId } of [...enrolled, ...volunteers, ...led]) {
            let set = programParticipants.get(programId);
            if (!set) programParticipants.set(programId, (set = new Set()));
            set.add(personId);
        }

        // (person, program) pairs where the household member staffs the program rather than enrolling.
        const volunteerKeys = new Set(volunteers.map(v => `${v.personId}:${v.programId}`));
        const leadKeys = new Set(led.map(l => `${l.personId}:${l.programId}`));

        const events = await prisma.event.findMany({
            where: {
                programId: { in: [...programParticipants.keys()] },
                endAt: { gte: new Date() } // Only upcoming
            },
            orderBy: { startAt: "asc" },
            include: {
                program: { select: { name: true } },
                rsvps: {
                    where: { personId: { in: householdMemberIds } },
                    select: { personId: true, status: true }
                }
            }
        });

        // One card per (event, participant-in-that-program), each with that
        // participant's own RSVP — so a household lead can respond for each one.
        const rows = events.flatMap((ev: typeof events[number]) => {
            const attendees = ev.programId ? programParticipants.get(ev.programId) : undefined;
            if (!attendees) return [];
            return householdMemberIds
                .filter(id => attendees.has(id))
                .map(pid => ({
                    id: ev.id,
                    name: ev.name,
                    description: ev.description,
                    startAt: ev.startAt,
                    endAt: ev.endAt,
                    program: ev.program,
                    participant: householdMemberById.get(pid),
                    rsvp: ev.rsvps.find((r: typeof ev.rsvps[number]) => r.personId === pid)?.status ?? null,
                    isVolunteer: volunteerKeys.has(`${pid}:${ev.programId}`),
                    isLead: leadKeys.has(`${pid}:${ev.programId}`)
                }));
        });

        return NextResponse.json(rows);
    } catch (error) {
        logger.error("Failed to fetch user events:", error);
        return apiError("Failed to fetch events", 500);
    }
});
