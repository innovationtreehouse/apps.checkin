import { NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import prisma from "@/lib/prisma";
import { Prisma } from "@/generated/prisma/client";
import { withAuth } from "@/lib/auth";
import { handler, notFound, forbidden, badRequest } from "@/security/handler";
import { apiError } from "@/lib/api-response";
import { parseVisitTime, departureAfterArrival, withinMaxDuration } from "@/lib/visitTimes";
import { LIVE_PERSON } from "@/lib/person/filters";
import { LIVE_VISIT } from "@/lib/visit/filters";
import { editSignificance, deleteSignificance } from "@/lib/visit/significance";

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
                        where: { person: LIVE_PERSON },
                        select: {
                            programId: true,
                            personId: true,
                            status: true,
                            person: { select: { id: true, name: true, email: true } }
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

    return { Event: event };
});

export const PATCH = withAuth({}, async (req: Request, auth, { params }: { params: Promise<{ id: string }> }) => {
    if (auth.type !== 'session') return apiError("Unauthorized", 401);

    const resolvedParams = await params;
    const eventId = parseInt(resolvedParams.id, 10);
    if (isNaN(eventId)) return apiError("Invalid event ID", 400);
    const body = await req.json();

    try {
        const event = await prisma.event.findUnique({
            where: { id: eventId },
            include: { program: { include: { volunteers: true } } }
        });

        if (!event) return apiError("Event not found", 404);

        const userId = auth.user.id;
        const isSysAdminOrBoard = auth.user.isSysadmin || auth.user.isBoardMember;
        const isLeadMentor = event.program?.leadMentorId === userId;
        const isCoreVolunteer = event.program?.volunteers?.some(v => v.personId === userId && v.isCore) || false;

        // Action: Confirm Attendance
        if (body.action === 'confirmAttendance') {
            if (!isSysAdminOrBoard && !isLeadMentor && !isCoreVolunteer) {
                return apiError("Forbidden: Not authorized to confirm attendance", 403);
            }

            const updatedEvent = await prisma.event.update({
                where: { id: eventId },
                data: { 
                    attendanceConfirmedAt: new Date(),
                    attendanceConfirmedById: userId 
                }
            });

            return NextResponse.json({ success: true, event: updatedEvent });
        }

        // Action: Edit / Cancel Time
        if (body.action === 'editTime' || body.action === 'cancel') {
            // Core volunteers can't edit or cancel events. Only lead mentors, isSysadmin, board.
            if (!isSysAdminOrBoard && !isLeadMentor) {
                return apiError("Forbidden: Only Lead Mentors or Admins can edit/cancel events", 403);
            }

            // Block edits to an event that has already finished — rescheduling a
            // past event is meaningless. Use endAt (not startAt) so an in-progress
            // event still edits.
            if (body.action === 'editTime' && event.endAt.getTime() < Date.now()) {
                return apiError("Cannot edit a past event", 400);
            }

            const { startAt, endAt, applyToFuture } = body;

            const timeShiftStartMs = startAt ? new Date(startAt).getTime() - event.startAt.getTime() : 0;
            const timeShiftEndMs = endAt ? new Date(endAt).getTime() - event.endAt.getTime() : 0;

            if (applyToFuture && event.recurringGroupId) {
                const futureEvents = await prisma.event.findMany({
                    where: {
                        recurringGroupId: event.recurringGroupId,
                        startAt: { gte: event.startAt }
                    }
                });

                if (body.action === 'cancel') {
                    const eventIds = futureEvents.map(e => e.id);
                    // Cleanup RSVPs and Visits first to avoid foreign key constraints.
                    // All three writes in one transaction so a mid-way failure rolls back.
                    await prisma.$transaction([
                        prisma.rSVP.deleteMany({ where: { eventId: { in: eventIds } } }),
                        prisma.visit.updateMany({ where: { associatedEventId: { in: eventIds } }, data: { associatedEventId: null } }),
                        prisma.event.deleteMany({ where: { id: { in: eventIds } } }),
                    ]);

                    return NextResponse.json({ success: true, count: futureEvents.length });
                } else if (body.action === 'editTime') {
                    const ops: Prisma.PrismaPromise<unknown>[] = futureEvents.map(fe => {
                        return prisma.event.update({
                            where: { id: fe.id },
                            data: {
                                startAt: new Date(fe.startAt.getTime() + timeShiftStartMs),
                                endAt: new Date(fe.endAt.getTime() + timeShiftEndMs)
                            }
                        });
                    });

                    await prisma.$transaction(ops);

                    return NextResponse.json({ success: true, count: futureEvents.length });
                }
            } else {
                // Apply ONLY to this single event
                if (body.action === 'cancel') {
                    // All three writes in one transaction so a mid-way failure rolls back.
                    await prisma.$transaction([
                        prisma.rSVP.deleteMany({ where: { eventId: event.id } }),
                        prisma.visit.updateMany({ where: { associatedEventId: event.id }, data: { associatedEventId: null } }),
                        prisma.event.delete({ where: { id: event.id } }),
                    ]);
                    return NextResponse.json({ success: true });
                } else if (body.action === 'editTime') {
                    const updatedEvent = await prisma.event.update({
                        where: { id: event.id },
                        data: {
                            startAt: startAt ? new Date(startAt) : event.startAt,
                            endAt: endAt ? new Date(endAt) : event.endAt
                        }
                    });
                    return NextResponse.json({ success: true, event: updatedEvent });
                }
            }
        }

        // Action: Manual Edit Attendance
        if (body.action === 'manualEditAttendance') {
            if (!isSysAdminOrBoard && !isLeadMentor && !isCoreVolunteer) {
                return apiError("Forbidden: Not authorized to edit attendance", 403);
            }

            const { participantId, status, arrivedAt, departedAt } = body;

            if (!participantId || !status) {
                return apiError("Missing required fields", 400);
            }

            // Authz on the TARGET: the participant must be enrolled or volunteering
            // in this event's program. Without this a lead mentor could write a
            // presence record for anyone in the system (see attendance POST). A
            // program-less event is reachable only by admin/board (lead/core-vol
            // authz above requires a program), so there is no IDOR to guard there.
            const targetId = Number(participantId);
            if (event.programId != null) {
                const [enrolled, volunteering] = await Promise.all([
                    prisma.programParticipant.findFirst({ where: { programId: event.programId, personId: targetId }, select: { personId: true } }),
                    prisma.programVolunteer.findFirst({ where: { programId: event.programId, personId: targetId }, select: { personId: true } }),
                ]);
                if (!enrolled && !volunteering) {
                    return apiError("Participant is not enrolled or volunteering in this program", 400);
                }
            }

            // Input validation before the lock — it depends on nothing we read.
            let dep: Date | null = null;
            let arrival: Date | null = null;
            if (status === 'Present') {
                if (!arrivedAt) {
                    return apiError("Arrival time is required for Present status", 400);
                }

                const now = new Date();
                const ar = parseVisitTime(arrivedAt, "arrival", now);
                if (!ar.ok) return apiError(ar.error, 400);
                arrival = ar.value;

                if (departedAt) {
                    const dr = parseVisitTime(departedAt, "departure", now);
                    if (!dr.ok) return apiError(dr.error, 400);
                    if (!departureAfterArrival(ar.value, dr.value)) {
                        return apiError("Departure time must be after arrival time", 400);
                    }
                    if (!withinMaxDuration(ar.value, dr.value)) {
                        return apiError("A visit cannot be longer than 24 hours.", 400);
                    }
                    dep = dr.value;
                }
            }

            // Read-modify-write on this person's visit state, exactly like /api/scan
            // and /api/attendance/manual: take the per-person advisory xact lock so a
            // correction can't race a kiosk scan or the facility-close sweep, and
            // re-read the visit state inside the lock. Returns an error message to
            // surface as a 400, or null on success.
            const failure = await prisma.$transaction(async (tx): Promise<string | null> => {
                await tx.$executeRaw`SELECT pg_advisory_xact_lock(${targetId})`;

                if (status === 'Absent') {
                    // An open visit (departedAt = null) means they physically scanned in
                    // and are currently on-site. Deleting it would destroy the live
                    // roster of who's in the building — reject instead.
                    const openVisit = await tx.visit.findFirst({
                        where: { personId: targetId, associatedEventId: eventId, departedAt: null, ...LIVE_VISIT }
                    });
                    if (openVisit) {
                        return "Participant is currently checked in — check them out before marking Absent";
                    }
                    // Only closed visits remain; safe to clear on an Absent
                    // correction — as a TOMBSTONE, never a row removal (design §3).
                    // A lead's Absent mark must be as reversible and reviewable as
                    // the member's own delete, and an already-tombstoned row is
                    // left alone: it is the record of an earlier deletion.
                    const doomed = await tx.visit.findMany({
                        where: { personId: targetId, associatedEventId: eventId, ...LIVE_VISIT }
                    });
                    if (doomed.length > 0) {
                        await tx.visit.updateMany({
                            where: { id: { in: doomed.map(v => v.id) }, ...LIVE_VISIT },
                            data: { deletedAt: new Date(), deletedById: userId }
                        });
                        // Every human visit-write logs (design "Audit substrate").
                        // Inside the lock, so the rows audited are exactly the rows
                        // tombstoned — no racing delete can strand a DELETE row
                        // crediting this lead with someone else's deletion.
                        await tx.auditLog.createMany({
                            data: doomed.map(v => ({
                                actorId: userId,
                                action: "DELETE",
                                tableName: "Visit",
                                affectedEntityId: v.id,
                                secondaryAffectedEntity: targetId,
                                oldData: {
                                    arrivedAt: v.arrivedAt, departedAt: v.departedAt,
                                    arrivedVia: v.arrivedVia, departedVia: v.departedVia,
                                    associatedEventId: v.associatedEventId
                                },
                                newData: {
                                    type: "lead_attendance_correction", status: "Absent",
                                    significance: deleteSignificance(v, { byProxy: userId !== targetId }),
                                }
                            }))
                        });
                    }
                    return null;
                }

                if (status !== 'Present') return null;

                // A person has at most one open LIVE visit
                // (Visit_one_open_per_participant excludes tombstones), so this finds
                // it whichever event — if any — it belongs to.
                const openVisit = await tx.visit.findFirst({
                    where: { personId: targetId, departedAt: null, ...LIVE_VISIT }
                });

                // A Present mark with no departure leaves the person open, and their
                // existing open visit IS that presence. Adopt an ordinary walk-in
                // (unassociated) into this event rather than writing a second open
                // visit, which the one-open-visit index rejects outright.
                const adoptable = openVisit !== null && (
                    openVisit.associatedEventId === eventId ||
                    (dep === null && openVisit.associatedEventId === null)
                );
                if (dep === null && openVisit && !adoptable) {
                    return "Participant is currently checked in for another session. Check them out, or set a departure time, before marking them Present here.";
                }

                const existingVisit = adoptable ? openVisit : await tx.visit.findFirst({
                    where: { personId: targetId, associatedEventId: eventId, ...LIVE_VISIT }
                });

                // arrivedVia records how the arrival was measured, not who last
                // touched the row. A visit this mark creates is staff-asserted
                // (createTimes -> LEAD_MARKED); an adopted walk-in whose arrival
                // is unchanged keeps its SCANNER/WEB. Only when a correction
                // genuinely moves the arrival time does it become a typed clock —
                // restamped TYPED on the update branch below, so the next
                // correction weighs it as a self-report. A departure the lead
                // typed is staff-asserted whatever the arrival was.
                const times = {
                    arrivedAt: arrival!,
                    departedAt: dep,
                    departedVia: departedAt ? "LEAD_MARKED" : null
                } satisfies Prisma.VisitUncheckedUpdateInput;
                const createTimes = { ...times, arrivedVia: "LEAD_MARKED" } satisfies Prisma.VisitUncheckedUpdateInput;

                // Every human visit-write logs (design "Audit substrate"), with
                // secondaryAffectedEntity = the subject so a correction review
                // reads actor ≠ subject without a join (§6.6).
                // Never reopen a closed visit: a Present mark with no departure
                // against a visit that has one would null it. facility/visits
                // PATCH refuses the same edit.
                if (existingVisit?.departedAt && !dep) {
                    return "This visit is already closed. Provide a departure time, or remove the visit instead of reopening it.";
                }

                if (existingVisit) {
                    // Restamp the arrival source only when the lead actually moved
                    // the arrival time — a Present mark that only re-times the
                    // departure (or purely adopts a walk-in) leaves the measured
                    // arrival, and its source, untouched. Compare at minute
                    // granularity: the client's datetime-local input is minute-
                    // precision, so an untouched sub-minute arrival round-trips to a
                    // slightly different value; only a whole-minute move is a real
                    // correction. ponytail: minute granularity, tighten if a
                    // finer-grained caller ever needs it.
                    const arrivalChanged =
                        Math.floor(arrival!.getTime() / 60000) !== Math.floor(existingVisit.arrivedAt.getTime() / 60000);
                    const updated = await tx.visit.update({
                        where: { id: existingVisit.id },
                        data: {
                            ...times,
                            associatedEventId: eventId,
                            ...(arrivalChanged ? { arrivedVia: "TYPED" } : {}),
                        }
                    });
                    await tx.auditLog.create({
                        data: {
                            actorId: userId,
                            action: "EDIT",
                            tableName: "Visit",
                            affectedEntityId: updated.id,
                            secondaryAffectedEntity: targetId,
                            oldData: {
                                arrivedAt: existingVisit.arrivedAt, departedAt: existingVisit.departedAt,
                                arrivedVia: existingVisit.arrivedVia, departedVia: existingVisit.departedVia,
                                associatedEventId: existingVisit.associatedEventId
                            },
                            newData: {
                                ...times, type: "lead_attendance_correction", status: "Present",
                                significance: editSignificance(existingVisit, { arrivedAt: arrival!, departedAt: dep }, { byProxy: userId !== targetId }),
                            }
                        }
                    });
                } else {
                    const created = await tx.visit.create({
                        data: { ...createTimes, personId: targetId, associatedEventId: eventId }
                    });
                    await tx.auditLog.create({
                        data: {
                            actorId: userId,
                            action: "CREATE",
                            tableName: "Visit",
                            affectedEntityId: created.id,
                            secondaryAffectedEntity: targetId,
                            newData: { ...createTimes, type: "lead_attendance_correction", status: "Present" }
                        }
                    });
                }
                return null;
            }, { maxWait: 5000, timeout: 15000 });

            if (failure) return apiError(failure, 400);

            return NextResponse.json({ success: true });
        }

        return apiError("Invalid action", 400);

    } catch (error: unknown) {
        logger.error("Failed to update event:", error);
        return apiError("Failed to update event", 500);
    }
});
