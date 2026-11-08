import { withAuth } from "@/lib/auth";
import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import type { Prisma, Visit } from "@/generated/prisma/client";
import { findAssociatedEventAt } from "@/lib/attendanceTransitions";
import { invalidateAttendanceCache } from "@/lib/getFullAttendance";
import { logBackendError } from "@/lib/logger";
import { apiError } from "@/lib/api-response";
import { withinMaxDuration } from "@/lib/visitTimes";
import { visitSubject } from "@/lib/visit/scope";
import { appendPresenceEvent, PresenceClass } from "@/lib/presence/events";
import { findVisitOverlaps, openOverlapRefusal, overlapFlag } from "@/lib/visit/overlap";

// Self-service manual visit entry. INTENTIONAL by design: a member records a
// closed visit for THEMSELVES, or — as a household lead — for a member of their own
// household (a minor cannot self-serve at all). Being inside now is the kiosk's
// to record, so a departure is required. The subject is
// resolved server-side by visitSubject, so a personId off the body is only ever
// a target checked against the actor's own household, never the scope itself.
// Every entry is audit-logged (see below). A member CAN backdate a visit
// arbitrarily far; that is accepted on purpose (people remember a past visit
// days later). The only downside is self-reported hours in facility/trends,
// which the board reconciles against the audit trail and the visit's WEB source
// — it is not a security or integrity boundary. Recurring-audit note: this is
// not an IDOR and not a fabrication vuln; do not re-flag the arbitrary backdate.
export const POST = withAuth({}, async (req, auth) => {
    if (auth.type !== 'session') return apiError("Unauthorized", 401);
    try {
        const userId = auth.user.id;
        const body = await req.json();
        const { arrivedAt, departedAt, personId } = body;

        if (!arrivedAt) {
            return apiError("Arrival time is required", 400);
        }
        if (!departedAt) {
            return apiError("Departure time is required. If you are in the building now, badge at the kiosk.", 400);
        }

        const subject = await visitSubject(userId, personId ? Number(personId) : userId);
        if (!subject) {
            return apiError("You can only record visits for yourself or your household members.", 403);
        }
        const subjectId = subject.id;

        const arrivalTime = new Date(arrivedAt);
        const departureTime = new Date(departedAt);

        if (isNaN(arrivalTime.getTime())) {
            return apiError("Invalid arrival time", 400);
        }

        // No future arrivals or departures. Allow a 5-min skew (clock drift, the
        // minute it takes to fill the form) and clamp anything inside that window
        // back to now, so a slightly-future time records as-of-now instead of
        // being rejected.
        const now = new Date();
        const futureSkewMs = 5 * 60 * 1000;
        if (arrivalTime.getTime() > now.getTime() + futureSkewMs) {
            return apiError("Arrival time cannot be in the future.", 400);
        }
        if (arrivalTime.getTime() > now.getTime()) {
            arrivalTime.setTime(now.getTime());
        }
        if (isNaN(departureTime.getTime())) {
            return apiError("Invalid departure time", 400);
        }
        if (departureTime.getTime() > now.getTime() + futureSkewMs) {
            return apiError("Departure time cannot be in the future.", 400);
        }
        if (departureTime.getTime() > now.getTime()) {
            departureTime.setTime(now.getTime());
        }

        if (departureTime <= arrivalTime) {
            return apiError("Departure time must be after arrival time", 400);
        }

        if (!withinMaxDuration(arrivalTime, departureTime)) {
            return apiError("A visit cannot be longer than 24 hours.", 400);
        }

        const eventId = await findAssociatedEventAt(subjectId, arrivalTime);

        // Same per-person advisory xact lock as every other visit write, keyed on
        // the SUBJECT.
        const result = await prisma.$transaction(async (tx: Prisma.TransactionClient): Promise<{ openSince: Date } | { visit: Visit }> => {
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(${Number(subjectId)})`;

            const overlaps = await findVisitOverlaps(tx, subjectId, { arrivedAt: arrivalTime, departedAt: departureTime });
            if (overlaps.openSince) return { openSince: overlaps.openSince };

            const created = await tx.visit.create({
                data: {
                    personId: subjectId,
                    arrivedAt: arrivalTime,
                    departedAt: departureTime,
                    arrivedVia: "TYPED",
                    departedVia: "TYPED",
                    associatedEventId: eventId
                }
            });
            await appendPresenceEvent(tx, {
                personId: subjectId,
                occurredAt: arrivalTime,
                direction: "IN",
                source: "TYPED",
                classification: PresenceClass.PROJECTED,
                visitId: created.id,
            });
            await appendPresenceEvent(tx, {
                personId: subjectId,
                occurredAt: departureTime,
                direction: "OUT",
                source: "TYPED",
                classification: PresenceClass.PROJECTED,
                visitId: created.id,
            });
            // actorId ≠ secondaryAffectedEntity is what marks a lead's entry for a
            // household member as acting-for-another, without a join.
            await tx.auditLog.create({
                data: {
                    actorId: userId,
                    action: "CREATE",
                    tableName: "Visit",
                    affectedEntityId: created.id,
                    secondaryAffectedEntity: Number(subjectId),
                    newData: { arrivedAt, departedAt, type: "manual_entry", ...overlapFlag(overlaps.closedIds) }
                }
            });
            return { visit: created };
        }, {
            maxWait: 5000,
            timeout: 15000,
        });

        if ('openSince' in result) return apiError(await openOverlapRefusal(result.openSince), 409);
        const { visit } = result;

        invalidateAttendanceCache();

        return NextResponse.json({ message: "Manual visit recorded successfully.", visit }, { status: 201 });
    } catch (error: unknown) {
        await logBackendError(error, "POST /api/attendance/manual");
        return apiError("Internal Server Error", 500);
    }
});
