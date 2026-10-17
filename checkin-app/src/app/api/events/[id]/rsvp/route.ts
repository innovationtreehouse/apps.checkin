import { NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import type { Session } from "next-auth";
import { withAuth } from "@/lib/auth";
import prisma from "@/lib/prisma";
import { canActFor } from "@/lib/household/activityMembers";
import { RSVP_STATUSES, type RSVPStatus } from "@/types/rsvp";
import { apiError } from "@/lib/api-response";

export const PATCH = withAuth({}, async (req, auth, { params }: { params: Promise<{ id: string }> }) => {
    if (auth.type !== 'session') return apiError("Unauthorized", 401);
    const { id } = await params;
    // canActFor only reads session.user; reconstruct the minimal shape from auth.user.
    const session = { user: auth.user } as unknown as Session;

    try {
        const eventId = parseInt(id, 10);
        if (isNaN(eventId)) {
            return apiError("Invalid event ID", 400);
        }

        const body = await req.json();
        const { status } = body;

        if (!status || !RSVP_STATUSES.includes(status)) {
            return apiError("Invalid RSVP status", 400);
        }

        // Target defaults to self; a household lead may RSVP for a member of
        // their household. Authorize the target before trusting it.
        const targetId = typeof body.participantId === "number" ? body.participantId : session.user.id;
        if (!(await canActFor(session, targetId))) {
            return apiError("Forbidden", 403);
        }
        const currentUserId = targetId;

        // Verify the event exists and the user is enrolled in the program (if applicable)
        const event = await prisma.event.findUnique({
            where: { id: eventId },
            include: { program: true }
        });

        if (!event) {
            return apiError("Event not found", 404);
        }

        // Can't RSVP to an event that already finished. Use endAt (not startAt) so an
        // in-progress event still accepts RSVPs.
        if (event.endAt.getTime() < Date.now()) {
            return apiError("Cannot RSVP to a past event", 400);
        }

        if (event.programId) {
            const isEnrolled = await prisma.programParticipant.findUnique({
                where: {
                    programId_personId: {
                        programId: event.programId,
                        personId: currentUserId
                    }
                }
            });
            const isVolunteer = await prisma.programVolunteer.findUnique({
                where: {
                    programId_personId: {
                        programId: event.programId,
                        personId: currentUserId
                    }
                }
            });

            const isLead = event.program?.leadMentorId === currentUserId;

            if (!isEnrolled && !isVolunteer && !isLead) {
                return apiError("Forbidden: You are not a participant of this program", 403);
            }
        }

        const rsvp = await prisma.rSVP.upsert({
            where: {
                eventId_personId: {
                    eventId,
                    personId: currentUserId
                }
            },
            update: {
                status: status as RSVPStatus
            },
            create: {
                eventId,
                personId: currentUserId,
                status: status as RSVPStatus
            }
        });

        return NextResponse.json({ success: true, rsvp });
    } catch (error) {
        logger.error("RSVP update error:", error);
        return apiError("Failed to update RSVP", 500);
    }
});
