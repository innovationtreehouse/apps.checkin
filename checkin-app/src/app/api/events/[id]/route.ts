import { NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import prisma from "@/lib/prisma";
import { withAuth } from "@/lib/auth";
import { handler, notFound, forbidden, badRequest } from "@/security/handler";
import { apiError } from "@/lib/api-response";
import { LIVE_PERSON, ENROLLED_PARTICIPANT } from "@/lib/person/filters";
import { LIVE_VISIT } from "@/lib/visit/filters";
import { rosterPerson } from "@/lib/person/leaderEmail";
import {
    loadEventEditContext,
    confirmAttendance,
    editEventTime,
    manualEditAttendance,
    type EventEditResult,
    type EventRefusal,
} from "@/lib/programs/events";

// FAIL-CLOSED, staff-only. This payload is fundamentally a roster — who is
// enrolled / RSVP'd / attended — and a participant's name, id, and the very
// existence of their enrollment/RSVP/Visit row are all tier 'public'. So the
// handler's per-FIELD stripping (which protects email/phone/dob) CANNOT hide the
// association "person <-> this event": stripping a non-staff caller to 'public'
// still leaks the whole attendee name list (incl. youth). Field-tiering guards
// fields; only admission guards the association. So we gate admission here.
//
// The gate can't live in the registry `authorize`: this route's [id] is an EVENT
// id, but resolveAccess's program-scoped checks key off params.id as a PROGRAM
// id (and fixing that touches the CODEOWNERS-gated access-resolvers). We have the
// fetched event here, so the event->program lead/core-vol check is done inline,
// exactly like the original hand-rolled gate. The registry policy + stripping
// remain as defense-in-depth on the staff tiers (admin -> everyones:*, this
// event's lead/core-vol -> their_program_participants:* via per-row scope).
export const GET = handler<{ id: string }>('GET /api/events/[id]', async ({ auth, params }) => {
    const eventId = parseInt(params.id, 10);
    if (isNaN(eventId)) throw badRequest('Invalid event ID');

    // Explicit select, not include: whole rows would ship every pii/personal/
    // internal Person and ProgramParticipant column to this event's lead mentors
    // and core volunteers, whose view grants their_program_participants on all
    // three tiers. Ids and the join keys below are not rendered — they are the
    // scope keys scopesHeld() reads to resolve their_program_participants /
    // their_own; drop one and the row strips to nothing for those roles.
    const event = await prisma.event.findUnique({
        where: { id: eventId },
        select: {
            id: true,
            programId: true,
            name: true,
            startAt: true,
            endAt: true,
            attendanceConfirmedAt: true,
            recurringGroupId: true,
            attendanceConfirmedBy: { select: { name: true } },
            program: {
                select: {
                    id: true,
                    name: true,
                    leadMentorId: true,
                    volunteers: {
                        where: { person: LIVE_PERSON },
                        select: {
                            programId: true,
                            personId: true,
                            isCore: true,
                            person: { select: { id: true, name: true, email: true } }
                        }
                    },
                    participants: {
                        where: { person: LIVE_PERSON, ...ENROLLED_PARTICIPANT },
                        select: {
                            programId: true,
                            personId: true,
                            status: true,
                            person: { select: { id: true, name: true, email: true, dateOfBirth: true } }
                        }
                    }
                }
            },
            visits: {
                where: LIVE_VISIT,
                // associatedEventId is the scope key a lead mentor / core volunteer
                // resolves their_program_participants on (Visit has no programId).
                // Unselected, the row fails closed and arrivedAt/departedAt strip
                // away for everyone but sysadmin/board.
                select: { id: true, personId: true, arrivedAt: true, departedAt: true, associatedEventId: true }
            },
            rsvps: {
                where: { person: LIVE_PERSON },
                select: { eventId: true, personId: true, status: true }
            }
        }
    });

    if (!event) throw notFound('Event not found');

    // Roster is staff-only (see header). Non-staff callers never receive it —
    // matches the original inline gate (403 for an existing event they don't staff).
    const isStaff = auth.type === 'session' && (
        auth.user.isSysadmin ||
        auth.user.isBoardMember ||
        event.program?.leadMentorId === auth.user.id ||
        (event.program?.volunteers?.some(v => v.personId === auth.user.id && v.isCore) ?? false)
    );
    if (!isStaff) throw forbidden('Forbidden: Not authorized to view this event');

    if (!event.program) return { Event: event };
    const viewerIsLeader = auth.type === 'session' && !auth.user.isSysadmin && !auth.user.isBoardMember;
    const participants = event.program.participants.map(p => ({ ...p, person: rosterPerson(p.person, viewerIsLeader) }));
    return { Event: { ...event, program: { ...event.program, participants } } };
});

export const PATCH = withAuth({}, async (req: Request, auth, { params }: { params: Promise<{ id: string }> }) => {
    if (auth.type !== 'session') return apiError("Unauthorized", 401);

    const resolvedParams = await params;
    const eventId = parseInt(resolvedParams.id, 10);
    if (isNaN(eventId)) return apiError("Invalid event ID", 400);
    const body = await req.json();

    try {
        const ctx = await loadEventEditContext(eventId, auth.user);
        if (!ctx) return apiError("Event not found", 404);

        let result: EventEditResult<object>;
        if (body.action === 'confirmAttendance') {
            result = await confirmAttendance(ctx);
        } else if (body.action === 'editTime' || body.action === 'cancel') {
            result = await editEventTime(ctx, body);
        } else if (body.action === 'manualEditAttendance') {
            result = await manualEditAttendance(ctx, body);
        } else {
            return apiError("Invalid action", 400);
        }

        if (!result.ok) return apiError(result.message, REFUSAL_STATUS[result.refusal]);
        return NextResponse.json({ success: true, ...result.value });
    } catch (error: unknown) {
        logger.error("Failed to update event:", error);
        return apiError("Failed to update event", 500);
    }
});

const REFUSAL_STATUS: Record<EventRefusal, number> = {
    invalid: 400,
    forbidden: 403,
    facility_closed: 403,
};
