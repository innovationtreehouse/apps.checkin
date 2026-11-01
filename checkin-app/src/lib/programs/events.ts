import prisma from "@/lib/prisma";
import { Prisma, type Event } from "@/generated/prisma/client";
import { parseVisitTime, departureAfterArrival, withinMaxDuration } from "@/lib/visitTimes";
import { LIVE_VISIT } from "@/lib/visit/filters";
import { invalidateAttendanceCache } from "@/lib/getFullAttendance";
import { editSignificance, deleteSignificance } from "@/lib/visit/significance";
import { intervalsOverlap } from "@/lib/attendanceConflicts";
import { findVisitOverlaps, openOverlapRefusal, overlapFlag } from "@/lib/visit/overlap";
import { OPEN_VISIT_REFUSAL } from "@/lib/visitTimes";

export interface EventEditor {
    id: number;
    isSysadmin: boolean;
    isBoardMember: boolean;
}

/** The event being edited and what the actor is to its program. */
export interface EventEditContext {
    event: Prisma.EventGetPayload<{ include: { program: { include: { volunteers: true } } } }>;
    actorId: number;
    isSysAdminOrBoard: boolean;
    isLeadMentor: boolean;
    isCoreVolunteer: boolean;
}

export type EventRefusal = "invalid" | "forbidden";

export type EventEditResult<T> =
    | { ok: true; value: T }
    | { ok: false; refusal: EventRefusal; message: string };

const refuse = (refusal: EventRefusal, message: string) => ({ ok: false as const, refusal, message });

export async function loadEventEditContext(eventId: number, actor: EventEditor): Promise<EventEditContext | null> {
    const event = await prisma.event.findUnique({
        where: { id: eventId },
        include: { program: { include: { volunteers: true } } }
    });
    if (!event) return null;

    return {
        event,
        actorId: actor.id,
        isSysAdminOrBoard: actor.isSysadmin || actor.isBoardMember,
        isLeadMentor: event.program?.leadMentorId === actor.id,
        isCoreVolunteer: event.program?.volunteers?.some(v => v.personId === actor.id && v.isCore) || false,
    };
}

export async function confirmAttendance(ctx: EventEditContext): Promise<EventEditResult<{ event: Event }>> {
    if (!ctx.isSysAdminOrBoard && !ctx.isLeadMentor && !ctx.isCoreVolunteer) {
        return refuse("forbidden", "Forbidden: Not authorized to confirm attendance");
    }

    const updatedEvent = await prisma.event.update({
        where: { id: ctx.event.id },
        data: {
            attendanceConfirmedAt: new Date(),
            attendanceConfirmedById: ctx.actorId
        }
    });

    return { ok: true, value: { event: updatedEvent } };
}

export interface EventTimeEdit {
    action: "editTime" | "cancel";
    startAt?: string;
    endAt?: string;
    /** Apply to this event and every later one in its recurring series. */
    applyToFuture?: boolean;
}

/** Reschedule or cancel an event, alone or with the rest of its series. */
export async function editEventTime(
    ctx: EventEditContext,
    { action, startAt, endAt, applyToFuture }: EventTimeEdit,
): Promise<EventEditResult<{ count?: number; event?: Event }>> {
    const { event } = ctx;
    // Core volunteers can't edit or cancel events. Only lead mentors, isSysadmin, board.
    if (!ctx.isSysAdminOrBoard && !ctx.isLeadMentor) {
        return refuse("forbidden", "Forbidden: Only Program Leaders or Admins can edit/cancel events");
    }

    // Block edits to an event that has already finished — rescheduling a
    // past event is meaningless. Use endAt (not startAt) so an in-progress
    // event still edits.
    if (action === 'editTime' && event.endAt.getTime() < Date.now()) {
        return refuse("invalid", "Cannot edit a past event");
    }

    const timeShiftStartMs = startAt ? new Date(startAt).getTime() - event.startAt.getTime() : 0;
    const timeShiftEndMs = endAt ? new Date(endAt).getTime() - event.endAt.getTime() : 0;

    if (applyToFuture && event.recurringGroupId) {
        const futureEvents = await prisma.event.findMany({
            where: {
                recurringGroupId: event.recurringGroupId,
                startAt: { gte: event.startAt }
            }
        });

        if (action === 'cancel') {
            const eventIds = futureEvents.map(e => e.id);
            // Cleanup RSVPs and Visits first to avoid foreign key constraints.
            // All three writes in one transaction so a mid-way failure rolls back.
            await prisma.$transaction([
                prisma.rSVP.deleteMany({ where: { eventId: { in: eventIds } } }),
                prisma.visit.updateMany({ where: { associatedEventId: { in: eventIds } }, data: { associatedEventId: null } }),
                prisma.event.deleteMany({ where: { id: { in: eventIds } } }),
            ]);
            invalidateAttendanceCache();
            return { ok: true, value: { count: futureEvents.length } };
        }

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
        return { ok: true, value: { count: futureEvents.length } };
    }

    // Apply ONLY to this single event
    if (action === 'cancel') {
        // All three writes in one transaction so a mid-way failure rolls back.
        await prisma.$transaction([
            prisma.rSVP.deleteMany({ where: { eventId: event.id } }),
            prisma.visit.updateMany({ where: { associatedEventId: event.id }, data: { associatedEventId: null } }),
            prisma.event.delete({ where: { id: event.id } }),
        ]);
        invalidateAttendanceCache();
        return { ok: true, value: {} };
    }

    const updatedEvent = await prisma.event.update({
        where: { id: event.id },
        data: {
            startAt: startAt ? new Date(startAt) : event.startAt,
            endAt: endAt ? new Date(endAt) : event.endAt
        }
    });
    return { ok: true, value: { event: updatedEvent } };
}

export interface AttendanceCorrection {
    participantId?: unknown;
    status?: unknown;
    arrivedAt?: string;
    departedAt?: string;
}

/**
 * A lead's Present/Absent correction of one person's visit to this event. A
 * Present mark records attendance: it links a kiosk visit covering the session,
 * or else writes a closed visit. It never opens a visit or ends one.
 */
export async function manualEditAttendance(
    ctx: EventEditContext,
    { participantId, status, arrivedAt, departedAt }: AttendanceCorrection,
): Promise<EventEditResult<Record<string, never>>> {
    const { event, actorId: userId } = ctx;
    const eventId = event.id;
    if (!ctx.isSysAdminOrBoard && !ctx.isLeadMentor && !ctx.isCoreVolunteer) {
        return refuse("forbidden", "Forbidden: Not authorized to edit attendance");
    }

    if (!participantId || !status) {
        return refuse("invalid", "Missing required fields");
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
            return refuse("invalid", "Participant is not enrolled or volunteering in this program");
        }
    }

    // Input validation before the lock — it depends on nothing we read.
    let dep: Date | null = null;
    let arrival: Date | null = null;
    if (status === 'Present') {
        const now = new Date();
        if (now < event.startAt) {
            return refuse("invalid", "Attendance can be marked once the session has started.");
        }
        if (!arrivedAt) {
            return refuse("invalid", "Arrival time is required for Present status");
        }
        if (!departedAt) {
            return refuse("invalid", "Departure time is required for Present status");
        }

        const ar = parseVisitTime(arrivedAt, "arrival", now);
        if (!ar.ok) return refuse("invalid", ar.error);
        arrival = ar.value;

        const dr = parseVisitTime(departedAt, "departure", now);
        if (!dr.ok) return refuse("invalid", dr.error);
        if (!departureAfterArrival(ar.value, dr.value)) {
            return refuse("invalid", "Departure time must be after arrival time");
        }
        if (!withinMaxDuration(ar.value, dr.value)) {
            return refuse("invalid", "A visit cannot be longer than 24 hours.");
        }
        dep = dr.value;
    }

    // Read-modify-write on this person's visit state, exactly like /api/scan
    // and /api/attendance/manual: take the per-person advisory xact lock so a
    // correction can't race a kiosk scan or the facility-close sweep, and
    // re-read the visit state inside the lock. Returns an error message to
    // surface as a refusal, or null on success.
    const failure = await prisma.$transaction(async (tx): Promise<string | { openSince: Date } | null> => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${targetId})`;

        if (status === 'Absent') {
            // An open visit (departedAt = null) means they physically scanned in
            // and are currently on-site. Deleting it would destroy the live
            // roster of who's in the building — reject instead.
            const openVisit = await tx.visit.findFirst({
                where: { personId: targetId, associatedEventId: eventId, departedAt: null, ...LIVE_VISIT }
            });
            if (openVisit) {
                return OPEN_VISIT_REFUSAL;
            }
            // Only closed visits remain; safe to clear on an Absent
            // correction — as a TOMBSTONE, never a row removal.
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
                // Every human visit-write logs.
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

        const visits = await tx.visit.findMany({ where: { personId: targetId, ...LIVE_VISIT } });
        const marked = { arrivedAt: arrival!, departedAt: dep };
        const session = { arrivedAt: event.startAt, departedAt: event.endAt };
        const existingVisit = visits.find(v => v.associatedEventId === eventId && !v.departedAt)
            ?? visits.find(v => v.associatedEventId === eventId);

        // Only the kiosk or the nightly close ends an open visit.
        if (existingVisit && !existingVisit.departedAt) return null;

        const covering = existingVisit ? undefined : visits.find(v => v.associatedEventId === null && (
            (v.arrivedVia === "SCANNER" && intervalsOverlap(v, session)) ||
            (!v.departedAt && intervalsOverlap(v, marked))
        ));
        if (covering) {
            await tx.visit.update({ where: { id: covering.id }, data: { associatedEventId: eventId } });
            await tx.auditLog.create({
                data: {
                    actorId: userId,
                    action: "EDIT",
                    tableName: "Visit",
                    affectedEntityId: covering.id,
                    secondaryAffectedEntity: targetId,
                    oldData: { associatedEventId: null },
                    newData: { associatedEventId: eventId, type: "lead_attendance_correction", status: "Present" },
                }
            });
            return null;
        }

        const overlaps = await findVisitOverlaps(tx, targetId, marked, existingVisit?.id);
        if (overlaps.openSince) return { openSince: overlaps.openSince };

        // arrivedVia records how the arrival was measured, not who last
        // touched the row. A visit this mark creates is staff-asserted
        // (createTimes -> LEAD_MARKED). A correction that keeps the arrival
        // keeps its source; one that moves it restamps TYPED on the update
        // branch below, so the next correction weighs it as a self-report. A
        // departure the lead typed is staff-asserted whatever the arrival was.
        const times = {
            arrivedAt: arrival!,
            departedAt: dep,
            departedVia: "LEAD_MARKED"
        } satisfies Prisma.VisitUncheckedUpdateInput;
        const createTimes = { ...times, arrivedVia: "LEAD_MARKED" } satisfies Prisma.VisitUncheckedUpdateInput;

        // Every human visit-write logs, with
        // secondaryAffectedEntity = the subject so a correction review
        // reads actor ≠ subject without a join (§6.6).
        if (existingVisit) {
            // Restamp the arrival source only when the lead actually moved
            // the arrival time — a Present mark that only re-times the
            // departure leaves the measured arrival, and its source, untouched. Compare at minute
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
                        ...overlapFlag(overlaps.closedIds, editSignificance(existingVisit, { arrivedAt: arrival!, departedAt: dep }, { byProxy: userId !== targetId })),
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
                    newData: { ...createTimes, type: "lead_attendance_correction", status: "Present", ...overlapFlag(overlaps.closedIds) }
                }
            });
        }
        return null;
    }, { maxWait: 5000, timeout: 15000 });
    invalidateAttendanceCache();

    if (failure) return refuse("invalid", typeof failure === "string" ? failure : await openOverlapRefusal(failure.openSince));
    return { ok: true, value: {} };
}
