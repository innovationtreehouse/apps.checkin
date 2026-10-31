import { handler, ApiResponseError, badRequest, notFound, unauthorized } from "@/security/handler";
import prisma from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma/client";
import { OPEN_VISIT_REFUSAL, parseVisitTime, departureAfterArrival, withinMaxDuration, isUnchangedTime } from "@/lib/visitTimes";
import { invalidateAttendanceCache } from "@/lib/getFullAttendance";
import { correctCloseTime } from "@/lib/attendance/close";
import { editSignificance, deleteSignificance } from "@/lib/visit/significance";
import { visitSubject } from "@/lib/visit/scope";
import { emailBoardMembers } from "@/lib/emailRecipients";
import { logBackendError } from "@/lib/logger";
import { formatDateTime } from "@/lib/time";
import { resolveDisplayTimezone } from "@/lib/appSettings";

// Self-correction of a member's own visits, and a household lead's correction
// of their household members' (trust-first, see
// docs/rules/attendance-checkin.md): the edit always
// applies — the only gates are validity (times parse, departure after arrival,
// ≤ 24h, closed visits only) and scope. Integrity is post-hoc: every change is
// audited, and a significant one (big delta × trusted old source, doubled when
// an adult edits someone else's record, or any delete) is flagged to the board.
// Recurring-audit note: arbitrary backdate is accepted on purpose here exactly
// as on the sibling POST — self-reported hours are not a security boundary.

async function loadEditableVisit(id: number, actorId: number) {
    const visit = await prisma.visit.findUnique({ where: { id } });
    // Out-of-scope and tombstoned both read as 404 — no existence oracle on
    // other people's visit ids.
    if (!visit || visit.deletedAt) return null;
    if (!(await visitSubject(actorId, visit.personId))) return null;
    return visit;
}

function flagBoard(kind: "edit" | "delete", visitId: number, actorName: string, byProxy: boolean, score: number, detail: string) {
    // Fire-and-forget (errors logged and swallowed inside the helper): the
    // flag is oversight, never a gate on the member's response.
    void emailBoardMembers("attendance.selfCorrectionFlag", {
        scope: byProxy ? "household" : "self",
        change: kind,
        visitId: String(visitId),
        actorName,
        verb: kind === "delete" ? "deleted" : "changed",
        whose: byProxy ? "a household member's" : "one of their own",
        score: String(score),
        detail,
    }, "Self-correction board flag failed:");
}

export const PATCH = handler<{ id: string }>('PATCH /api/attendance/manual/[id]', async ({ req, auth, params }) => {
    if (auth.type !== 'session') throw unauthorized();
    try {
        const userId = auth.user.id;
        const visitId = Number(params.id);
        if (!Number.isInteger(visitId)) throw badRequest("Invalid visit id");

        const body = await req.json().catch(() => null);
        if (!body || typeof body !== "object") throw badRequest("Invalid JSON");
        const { arrivedAt, departedAt } = body;
        if (!arrivedAt && !departedAt) throw badRequest("Nothing to change.");

        const visit = await loadEditableVisit(visitId, userId);
        if (!visit) throw notFound("Visit not found.");
        if (!visit.departedAt) throw new ApiResponseError(409, OPEN_VISIT_REFUSAL);
        const byProxy = visit.personId !== userId;

        const now = new Date();
        let nextArrived = visit.arrivedAt;
        let nextDeparted: Date | null = visit.departedAt;
        let arrivalEdited = false;
        let departureEdited = false;

        if (arrivedAt) {
            const r = parseVisitTime(arrivedAt, "arrival", now);
            if (!r.ok) throw badRequest(r.error);
            arrivalEdited = !isUnchangedTime(r.value, visit.arrivedAt);
            if (arrivalEdited) nextArrived = r.value;
        }
        if (departedAt) {
            const r = parseVisitTime(departedAt, "departure", now);
            if (!r.ok) throw badRequest(r.error);
            departureEdited = !isUnchangedTime(r.value, visit.departedAt);
            if (departureEdited) nextDeparted = r.value;
        }
        if (!arrivalEdited && !departureEdited) throw badRequest("Nothing to change.");

        if (nextDeparted && !departureAfterArrival(nextArrived, nextDeparted)) {
            throw badRequest("Departure time must be after arrival time");
        }
        if (nextDeparted && !withinMaxDuration(nextArrived, nextDeparted)) {
            throw badRequest("A visit cannot be longer than 24 hours.");
        }

        const significance = editSignificance(visit, { arrivedAt: nextArrived, departedAt: nextDeparted }, { byProxy });

        // Same per-person advisory lock as every other visit write: an edit
        // must not race the kiosk, the sweep, or a concurrent submit. The lock
        // is keyed on the visit's PERSON, not the actor — that is the key the
        // one-open-visit invariant is per, so a lead's edit serializes against
        // the member's own kiosk scan.
        const updated = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(${Number(visit.personId)})`;
            // Scope and liveness re-asserted under the lock: a DELETE that
            // landed since the pre-check must not have its tombstone overwritten.
            const live = await tx.visit.findFirst({
                where: { id: visitId, personId: visit.personId, deletedAt: null },
            });
            if (!live) return null;
            // The validation above read the visit before the lock; re-check the
            // times that will actually be stored against the row as it is now.
            if (!!live.departedAt !== !!visit.departedAt) {
                throw new ApiResponseError(409, "This visit changed while you were editing it. Reload and try again.");
            }
            if (!arrivalEdited) nextArrived = live.arrivedAt;
            if (!departureEdited) nextDeparted = live.departedAt;
            if (nextDeparted && !departureAfterArrival(nextArrived, nextDeparted)) {
                throw badRequest("Departure time must be after arrival time");
            }
            if (nextDeparted && !withinMaxDuration(nextArrived, nextDeparted)) {
                throw badRequest("A visit cannot be longer than 24 hours.");
            }
            // A corrected time becomes a typed clock: an edited arrival stamps
            // arrivedVia TYPED, an edited departure stamps departedVia TYPED.
            // Significance already read the pre-edit source above, so restamping
            // here only sets what the NEXT correction overwrites — a second
            // correction of the same time weighs it as a self-report, not a
            // measurement (docs/rules/attendance-checkin.md, visit-record).
            const edited = await tx.visit.update({
                where: { id: visitId },
                data: {
                    ...(arrivalEdited ? { arrivedAt: nextArrived, arrivedVia: "TYPED" } : {}),
                    ...(departureEdited ? { departedAt: nextDeparted, departedVia: "TYPED" } : {}),
                },
            });
            // The closer correcting their own departure corrects the close they made.
            if (departureEdited) {
                const close = await tx.facilityClose.findFirst({
                    where: { closerVisitId: visitId, closedById: userId },
                    select: { id: true, closedAt: true, closedById: true },
                });
                if (close) await correctCloseTime(tx, close, userId, nextDeparted!);
            }
            return edited;
        }, { maxWait: 5000, timeout: 15000 });
        if (!updated) throw notFound("Visit not found.");
        invalidateAttendanceCache();
        const surviving = updated;

        await prisma.auditLog.create({
            data: {
                actorId: userId,
                action: "EDIT",
                tableName: "Visit",
                affectedEntityId: surviving.id,
                secondaryAffectedEntity: visit.personId,
                oldData: { id: visit.id, arrivedAt: visit.arrivedAt, departedAt: visit.departedAt, arrivedVia: visit.arrivedVia, departedVia: visit.departedVia },
                newData: { arrivedAt: nextArrived, departedAt: nextDeparted, type: "self_correction", significance },
            }
        });

        if (significance.flagged) {
            // Server-side: no TimezoneProvider here, so the configured zone is passed in.
            const timeZone = await resolveDisplayTimezone();
            flagBoard("edit", surviving.id, auth.user.name ?? `person #${userId}`, byProxy, significance.score,
                `${formatDateTime(visit.arrivedAt, { timeZone })} → ${formatDateTime(nextArrived, { timeZone })}`);
        }

        // The bag, not a hand-built body: stripBag keeps arrivedAt/departedAt for
        // the two subjects the registry grants (their_own / led_households) and
        // drops the 'internal' tombstone columns the raw row carries.
        return { Visit: surviving };
    } catch (error: unknown) {
        // handler() maps ApiResponseError to its declared status; anything else
        // is a real fault, and keeps the DB error log withAuth used to give it.
        if (!(error instanceof ApiResponseError)) await logBackendError(error, "PATCH /api/attendance/manual/[id]");
        throw error;
    }
});

export const DELETE = handler<{ id: string }>('DELETE /api/attendance/manual/[id]', async ({ auth, params }) => {
    if (auth.type !== 'session') throw unauthorized();
    try {
        const userId = auth.user.id;
        const visitId = Number(params.id);
        if (!Number.isInteger(visitId)) throw badRequest("Invalid visit id");

        const visit = await loadEditableVisit(visitId, userId);
        if (!visit) throw notFound("Visit not found.");
        if (!visit.departedAt) throw new ApiResponseError(409, OPEN_VISIT_REFUSAL);
        const byProxy = visit.personId !== userId;

        const significance = deleteSignificance(visit, { byProxy });

        // Tombstone, never a row removal: the deletion is reviewable in AT12
        // and reversible by clearing deletedAt. Same advisory lock as above, and
        // scope/liveness re-asserted inside it so a racing second delete is
        // a 404 rather than a re-stamped deletedAt.
        const tombstoned = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(${Number(visit.personId)})`;
            return tx.visit.updateMany({
                where: { id: visitId, personId: visit.personId, deletedAt: null },
                data: { deletedAt: new Date(), deletedById: userId },
            });
        });
        if (tombstoned.count === 0) throw notFound("Visit not found.");
        invalidateAttendanceCache();

        await prisma.auditLog.create({
            data: {
                actorId: userId,
                action: "DELETE",
                tableName: "Visit",
                affectedEntityId: visitId,
                secondaryAffectedEntity: visit.personId,
                oldData: { arrivedAt: visit.arrivedAt, departedAt: visit.departedAt, arrivedVia: visit.arrivedVia, departedVia: visit.departedVia },
                newData: { type: "self_correction", significance },
            }
        });

        // Every delete flags — the floor (§2).
        const timeZone = await resolveDisplayTimezone();
        flagBoard("delete", visitId, auth.user.name ?? `person #${userId}`, byProxy, significance.score,
            `Visit ${formatDateTime(visit.arrivedAt, { timeZone })} – ${formatDateTime(visit.departedAt, { timeZone })} tombstoned.`);

        // Empty bag — a tombstone ships no model data, so the registry declares
        // `envelope: null` and the 200 body is `{}` (stripBag drops any
        // non-model key, so the old { success, flagged } has no legal home).
        return {};
    } catch (error: unknown) {
        if (!(error instanceof ApiResponseError)) await logBackendError(error, "DELETE /api/attendance/manual/[id]");
        throw error;
    }
});
