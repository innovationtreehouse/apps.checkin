import prisma from "@/lib/prisma";
import { handler, badRequest, notFound, unauthorized, ApiResponseError } from "@/security/handler";
import { appendPresenceEvent, classifyPresenceEvent, PresenceClass } from "@/lib/presence/events";
import { findAssociatedEventAt, processVisitCheckout } from "@/lib/attendanceTransitions";
import { withinMaxDuration } from "@/lib/visitTimes";
import { lockFacility } from "@/lib/facilityLock";
import { LIVE_PERSON } from "@/lib/person/filters";
import { LIVE_VISIT } from "@/lib/visit/filters";
import { invalidateAttendanceCache } from "@/lib/getFullAttendance";

// Registry-governed (POST /api/system-status/unsynced-scans/[id]): admission
// anyRole sysadmin/board/keyholder (Q15; operations stay out — #1633);
// envelope null. `[id]` is a RawBadgeLog id.
//
// Two actions, both stamping the review columns exactly once:
//
// Dismiss (default) — "I looked, nothing to do." Touches nothing else;
// reviewReason is left intact so the row keeps saying why it parked.
//
// Record (§5.26/B4, ruled 2026-08-28) — writes the Visit the parked scan
// described, at the row's OWN timestamp, never at resolution time. The
// manual tool's 6h/same-day staleness bound deliberately does NOT apply: it
// guards a human's memory, and this row is machine-stamped at the door. An
// IN with no matching OUT is the caller's choice (Q13 human-always): leave
// the visit open — allowed only while the facility is live-open, since an
// open visit joins today's supervision math — or close it at a departure
// the reviewer supplies. A scan whose presence event is a departure (OUT)
// refuses: minting an arrival from it would invert the person's day.
//
// Concurrency: the same per-participant advisory lock as /api/scan and the
// manual route, plus the facility lock. The updateMany where clause stamps exactly once, so a
// double-click (either action) 404s and its transaction rolls back.
export const POST = handler<{ id: string }>(
    'POST /api/system-status/unsynced-scans/[id]',
    async ({ req, auth, params }) => {
        if (auth.type !== 'session') throw unauthorized();

        const id = Number(params.id);
        if (!Number.isInteger(id)) throw badRequest("Invalid scan id");

        // An empty body is a plain dismiss; a body that fails to parse is a
        // caller bug — refusing beats silently running the destructive default.
        let body: { action?: unknown; departedAt?: unknown } = {};
        const raw = await req.text();
        if (raw.trim().length > 0) {
            try {
                body = JSON.parse(raw);
            } catch {
                throw badRequest("Request body is not valid JSON.");
            }
        }
        const action = body.action ?? 'dismiss';
        if (action !== 'dismiss' && action !== 'record') {
            throw badRequest("action must be 'dismiss' or 'record'.");
        }

        if (action === 'dismiss') {
            const { count } = await prisma.rawBadgeLog.updateMany({
                where: { id, reviewReason: { not: null }, reviewedAt: null },
                data: { reviewedAt: new Date(), reviewedBy: auth.user.id },
            });
            if (count === 0) throw notFound("No scan awaiting review with that id.");
            return {};
        }

        const parsedDeparted = typeof body.departedAt === 'string' ? new Date(body.departedAt) : null;
        if (body.departedAt !== undefined && (!parsedDeparted || isNaN(parsedDeparted.getTime()))) {
            throw badRequest("departedAt must be an ISO date string.");
        }

        const row = await prisma.rawBadgeLog.findFirst({
            where: { id, reviewReason: { not: null }, reviewedAt: null },
        });
        if (!row) throw notFound("No scan awaiting review with that id.");
        if (row.personId === null) {
            throw new ApiResponseError(409, "This scan matches no one on record — dismiss it once you have looked.");
        }
        if (parsedDeparted && parsedDeparted <= row.timestamp) {
            throw badRequest("departedAt must be after the scan time.");
        }
        // The ruling waived arrival STALENESS, not visit LENGTH — a wrong-day
        // typo must not mint a multi-day visit.
        if (parsedDeparted && !withinMaxDuration(row.timestamp, parsedDeparted)) {
            throw badRequest("A visit cannot be longer than 24 hours.");
        }

        // A merge racing the review leaves a tombstone; one hop reaches the
        // keeper (the archive design guarantees chains never exceed it).
        const scanned = await prisma.person.findUnique({ where: { id: row.personId } });
        if (!scanned) throw notFound("No scan awaiting review with that id.");
        const person = scanned.mergedIntoId
            ? ((await prisma.person.findFirst({ where: { id: scanned.mergedIntoId, ...LIVE_PERSON } })) ?? scanned)
            : scanned;

        const associatedEventId = await findAssociatedEventAt(person.id, row.timestamp);

        const visitId = await prisma.$transaction(async (tx) => {
            // Same lock order as the manual route: participant, then facility.
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(${person.id})`;
            await lockFacility(tx);

            // The linked presence event is read under the locks, so its
            // classification cannot move between this read and our commit.
            const ev = row.clientEventId
                ? await tx.presenceEvent.findUnique({ where: { clientEventId: row.clientEventId } })
                : null;
            if (ev && ev.direction === 'OUT') {
                throw new ApiResponseError(409, "This parked scan is a departure, not an arrival — dismiss it, or correct the departure in the manual visits tool.");
            }
            if (ev && !ev.classification?.startsWith('PARKED')) {
                throw new ApiResponseError(409, "This scan's event was already resolved elsewhere — dismiss the row.");
            }

            // Interval intersection with any live visit means this scan is
            // already accounted for — minting another would double-count the
            // person (an open visit intersects everything after its arrival,
            // which also makes leave-open impossible while one exists).
            const overlapping = await tx.visit.findFirst({
                where: {
                    personId: person.id,
                    ...LIVE_VISIT,
                    ...(parsedDeparted ? { arrivedAt: { lt: parsedDeparted } } : {}),
                    OR: [{ departedAt: null }, { departedAt: { gt: row.timestamp } }],
                },
                select: { id: true },
            });
            if (overlapping) {
                throw new ApiResponseError(409, "A visit already covers that scan time — dismiss the row instead.");
            }

            // Leaving the visit open puts this person in TODAY's live roster,
            // so the live rule applies: a non-keyholder cannot be the only one
            // in the building (#254 keyholder-first).
            if (!parsedDeparted && !person.isKeyholder) {
                const activeKeyholders = await tx.visit.count({
                    where: { departedAt: null, person: { isKeyholder: true, ...LIVE_PERSON }, ...LIVE_VISIT },
                });
                if (activeKeyholders === 0) {
                    throw new ApiResponseError(403, "Facility is closed — supply a departure time to record this visit as closed.");
                }
            }

            const visit = await tx.visit.create({
                data: {
                    personId: person.id,
                    arrivedAt: row.timestamp,
                    departedAt: parsedDeparted,
                    arrivedVia: "SCANNER",
                    departedVia: parsedDeparted ? "TYPED" : null,
                    associatedEventId,
                },
            });

            const { count } = await tx.rawBadgeLog.updateMany({
                where: { id, reviewReason: { not: null }, reviewedAt: null },
                data: { reviewedAt: new Date(), reviewedBy: auth.user.id },
            });
            if (count === 0) throw notFound("No scan awaiting review with that id.");

            // Close the loop in the presence log: the parked arrival event is
            // re-projected onto the minted Visit; a row with no event (legacy,
            // web) gets one appended so the log still tells the whole story.
            if (ev) {
                await classifyPresenceEvent(tx, ev.id, PresenceClass.PROJECTED, visit.id);
            } else {
                await appendPresenceEvent(tx, {
                    personId: person.id,
                    occurredAt: row.timestamp,
                    direction: "IN",
                    source: "SCANNER",
                    classification: PresenceClass.PROJECTED,
                    visitId: visit.id,
                });
            }
            if (parsedDeparted) {
                await appendPresenceEvent(tx, {
                    personId: person.id,
                    occurredAt: parsedDeparted,
                    direction: "OUT",
                    source: "TYPED",
                    classification: PresenceClass.PROJECTED,
                    visitId: visit.id,
                });
            }

            return visit.id;
        }, {
            maxWait: 5000,
            timeout: 15000,
        });

        // Same back-to-back transition handling a manual closed backfill gets.
        if (parsedDeparted) {
            await processVisitCheckout(visitId, parsedDeparted, undefined, "TYPED");
        }
        invalidateAttendanceCache();

        await prisma.auditLog.create({
            data: {
                actorId: auth.user.id,
                action: "CREATE",
                tableName: "Visit",
                affectedEntityId: visitId,
                secondaryAffectedEntity: person.id,
                newData: {
                    arrivedAt: row.timestamp.toISOString(),
                    departedAt: parsedDeparted?.toISOString() ?? null,
                    type: "parked_scan_resolution",
                    rawBadgeLogId: row.id,
                },
            },
        });

        // Empty bag — the panel drops the row client-side; the registry
        // declares `envelope: null` and the 200 body is `{}`.
        return {};
    },
);
