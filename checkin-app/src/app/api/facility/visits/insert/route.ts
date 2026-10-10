import prisma from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma/client";
import { handler, badRequest, notFound, unauthorized } from "@/security/handler";
import { parseVisitTime, departureAfterArrival, withinMaxDuration } from "@/lib/visitTimes";
import { findAssociatedEventAt } from "@/lib/attendanceTransitions";
import { LIVE_PERSON } from "@/lib/person/filters";
import { invalidateAttendanceCache } from "@/lib/getFullAttendance";

// Staff insert-for-others at an arbitrary past time (design §3): the path for a
// genuine unenrolled walk-in, which the event-roster mark (program-scoped, event
// window) and the kiosk (live, badge-driven) cannot record. Unlike the
// self-service route the target personId IS taken from the body — that is the
// point of the endpoint — so the role gate is the whole boundary. Declared in
// the security registry (POST /api/facility/visits/insert); it sits on its own
// path rather than as a POST on the sibling /api/facility/visits for the
// lint-ordering reason recorded there and in #1491.
export const POST = handler('POST /api/facility/visits/insert', async ({ req, auth }) => {
    if (auth.type !== 'session') throw unauthorized();

    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object") throw badRequest("Invalid JSON");
    const { personId, arrivedAt, departedAt } = body;

    if (!personId) throw badRequest("personId is required.");
    if (!arrivedAt) throw badRequest("Arrival time is required");
    // Closed visits only. An open one would put someone on the live
    // in-the-building roster on staff say-so, and leave an open visit
    // nobody will badge out of; the kiosk owns live presence.
    if (!departedAt) throw badRequest("Departure time is required.");

    const now = new Date();
    const ar = parseVisitTime(arrivedAt, "arrival", now);
    if (!ar.ok) throw badRequest(ar.error);
    const dr = parseVisitTime(departedAt, "departure", now);
    if (!dr.ok) throw badRequest(dr.error);
    if (!departureAfterArrival(ar.value, dr.value)) {
        throw badRequest("Departure time must be after arrival time");
    }
    if (!withinMaxDuration(ar.value, dr.value)) {
        throw badRequest("A visit cannot be longer than 24 hours.");
    }

    const subjectId = Number(personId);
    const person = await prisma.person.findFirst({
        where: { id: subjectId, ...LIVE_PERSON },
        select: { id: true },
    });
    if (!person) throw notFound("Person not found.");

    const eventId = await findAssociatedEventAt(subjectId, ar.value);

    // Same per-person advisory lock as every other visit write, so this
    // insert can't race the kiosk or the facility-close sweep.
    const visit = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${subjectId})`;
        return tx.visit.create({
            data: {
                personId: subjectId,
                arrivedAt: ar.value,
                departedAt: dr.value,
                // Typed clocks, staff actor. How is TYPED; who is the audit
                // actor vs subject (#1624). Not LEAD_MARKED (that is an event
                // window, no clock).
                arrivedVia: "TYPED",
                departedVia: "TYPED",
                associatedEventId: eventId,
            },
        });
    });
    // A closed keyholder visit can cover someone's arrival and clear their
    // "no keyholder" mark on the live roster.
    invalidateAttendanceCache();

    await prisma.auditLog.create({
        data: {
            actorId: auth.user.id,
            action: "CREATE",
            tableName: "Visit",
            affectedEntityId: visit.id,
            secondaryAffectedEntity: subjectId,
            newData: { arrivedAt: ar.value, departedAt: dr.value, type: "staff_entry" },
        },
    });

    return { Visit: visit };
});
