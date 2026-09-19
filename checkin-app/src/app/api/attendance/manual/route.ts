import { withAuth } from "@/lib/auth";
import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma/client";
import { findAssociatedEventAt, processVisitCheckout } from "@/lib/attendanceTransitions";
import { invalidateAttendanceCache } from "@/lib/getFullAttendance";
import { sendCheckinNotifications } from "@/lib/notifications";
import { logBackendError, logger } from "@/lib/logger";
import { apiError } from "@/lib/api-response";
import { withinMaxDuration } from "@/lib/visitTimes";
import { LIVE_VISIT } from "@/lib/visit/filters";
import { visitSubject } from "@/lib/visit/scope";
import { lockFacility } from "@/lib/facilityLock";
import { appendPresenceEvent, PresenceClass } from "@/lib/presence/events";
import { flushParkedClosed } from "@/lib/presence/project";

// Self-service manual visit entry. INTENTIONAL by design: a member records a
// visit for THEMSELVES, or — as a household lead — for a member of their own
// household (design §3; a minor cannot self-serve at all). The subject is
// resolved server-side by visitSubject, so a personId off the body is only ever
// a target checked against the actor's own household, never the scope itself.
// Every entry is audit-logged (see below). A member CAN backdate a closed visit
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

        const subject = await visitSubject(userId, personId ? Number(personId) : userId);
        if (!subject) {
            return apiError("You can only record visits for yourself or your household members.", 403);
        }
        const subjectId = subject.id;

        const arrivalTime = new Date(arrivedAt);
        const departureTime = departedAt ? new Date(departedAt) : null;

        if (isNaN(arrivalTime.getTime())) {
            return apiError("Invalid arrival time", 400);
        }

        // No future arrivals. Allow a 5-min skew (clock drift, the minute it takes
        // to fill the form) and clamp anything inside that window back to now, so a
        // slightly-future time records as-of-now instead of being rejected.
        const now = new Date();
        if (arrivalTime.getTime() > now.getTime() + 5 * 60 * 1000) {
            return apiError("Arrival time cannot be in the future.", 400);
        }
        if (arrivalTime.getTime() > now.getTime()) {
            arrivalTime.setTime(now.getTime());
        }
        if (departureTime && isNaN(departureTime.getTime())) {
            return apiError("Invalid departure time", 400);
        }

        if (departureTime && departureTime <= arrivalTime) {
            return apiError("Departure time must be after arrival time", 400);
        }

        if (departureTime && !withinMaxDuration(arrivalTime, departureTime)) {
            return apiError("A visit cannot be longer than 24 hours.", 400);
        }

        // Blank departure means "still in the building" → an open visit. Only allow
        // that for a recent arrival: today (same calendar day) or within the last
        // 6 hours (covers arriving late last night and still being here). A stale
        // arrival with no departure would create a permanent open visit nobody
        // scanned out of, so require a departure for it.
        if (!departureTime) {
            const withinSixHours = now.getTime() - arrivalTime.getTime() <= 6 * 60 * 60 * 1000;
            const sameDay = arrivalTime.toDateString() === now.toDateString();
            if (!withinSixHours && !sameDay) {
                return apiError("Departure time is required for past arrivals.", 400);
            }
        }

        const eventId = await findAssociatedEventAt(subjectId, arrivalTime);

        // Creating an open visit (no departure) is a read-modify-write on this
        // participant's visit state, just like /api/scan. Take the same
        // per-participant advisory xact lock — keyed on the SUBJECT, the key the
        // one-open-visit invariant is per — and re-check for an existing open
        // visit before creating, so two concurrent manual submits — or a manual
        // submit racing a kiosk scan — can't leave two open visits for one
        // participant (checkout closes only one, the other lingers forever).
        const result = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(${Number(subjectId)})`;
            if (!departureTime) {
                await lockFacility(tx);
            }

            // Only an open visit carries dedup-able state; a closed one (departure
            // provided) is just a historical record, so multiple are fine.
            if (!departureTime) {
                const openVisit = await tx.visit.findFirst({
                    where: { personId: subjectId, departedAt: null, ...LIVE_VISIT }
                });
                if (openVisit) return { visit: openVisit, freshCheckin: false };

                // An open backfill claims the SUBJECT is in the building NOW, so
                // the same facility-open guard as /api/scan applies: a
                // non-keyholder cannot be the first (only) person present.
                // Whose standing counts is the subject's — a lead cannot open
                // the building by backfilling a visit for their child. A closed
                // backfill is historical and never gates. Checked under the lock
                // so a racing keyholder check-in is either committed-and-seen or
                // not yet.
                const subjectIsKeyholder = subjectId === userId ? auth.user.isKeyholder : subject.isKeyholder;
                if (!subjectIsKeyholder) {
                    const activeKeyholders = await tx.visit.count({
                        where: { departedAt: null, person: { isKeyholder: true }, ...LIVE_VISIT }
                    });
                    // Keyholder-first stands for staff backfills (#254 ruling):
                    // a refused request writes nothing — projection C's hold is
                    // for kiosk scans, which must never be lost.
                    if (activeKeyholders === 0) return { facilityClosed: true as const };
                }
            }

            const created = await tx.visit.create({
                data: {
                    personId: subjectId,
                    arrivedAt: arrivalTime,
                    departedAt: departureTime,
                    arrivedVia: "TYPED",
                    departedVia: departureTime ? "TYPED" : null,
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
            if (departureTime) {
                await appendPresenceEvent(tx, {
                    personId: subjectId,
                    occurredAt: departureTime,
                    direction: "OUT",
                    source: "TYPED",
                    classification: PresenceClass.PROJECTED,
                    visitId: created.id,
                });
            }
            // freshCheckin only when a NEW open visit was created — not a backfilled
            // closed visit (has departure) and not the dedup return above.
            return { visit: created, freshCheckin: !departureTime };
        }, {
            maxWait: 5000,
            timeout: 15000,
        });

        if ('facilityClosed' in result) {
            return apiError("Facility is closed. A Keyholder must check in first.", 403);
        }
        const { visit, freshCheckin } = result;

        const subjectIsKeyholder = subjectId === userId ? auth.user.isKeyholder : subject.isKeyholder;
        if (freshCheckin && subjectIsKeyholder) {
            await prisma.$transaction(async (tx) => {
                await tx.$executeRaw`SELECT pg_advisory_xact_lock(${Number(subjectId)})`;
                // flushParkedClosed takes the facility lock itself (reentrant).
                await flushParkedClosed(tx);
            });
        }

        // If a departure time was provided, we process the checkout logic directly
        // to handle any back-to-back event transitions.
        if (departureTime) {
             await processVisitCheckout(visit.id, departureTime, undefined, "TYPED");
        }

        // Fire-and-forget: notify only on a fresh active check-in (mirrors /api/scan).
        // A backfilled closed visit is a historical record, not a live arrival.
        invalidateAttendanceCache();

        if (freshCheckin) {
            sendCheckinNotifications(Number(subjectId), 'checkin').catch(err =>
                logger.error('Checkin notification error:', err)
            );
        }

        // actorId ≠ secondaryAffectedEntity is what marks a lead's entry for a
        // household member as acting-for-another, without a join (design §6.6).
        await prisma.auditLog.create({
            data: {
                actorId: userId,
                action: "CREATE",
                tableName: "Visit",
                affectedEntityId: visit.id,
                secondaryAffectedEntity: Number(subjectId),
                newData: { arrivedAt, departedAt, type: "manual_entry" }
            }
        });

        return NextResponse.json({ message: "Manual visit recorded successfully.", visit }, { status: 201 });
    } catch (error: unknown) {
        await logBackendError(error, "POST /api/attendance/manual");
        return apiError("Internal Server Error", 500);
    }
});
