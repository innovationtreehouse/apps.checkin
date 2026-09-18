import prisma from "@/lib/prisma";
import { type DbClient, type TxClient, withTx } from "@/lib/db-client";
import { MAX_VISIT_MS } from "@/lib/visitTimes";
import { invalidateAttendanceCache } from "@/lib/getFullAttendance";

/**
 * Finds all program IDs that a participant is associated with
 * (as enrolled participant, volunteer, or lead mentor).
 * Uses Promise.all for parallel queries.
 */
async function getRelevantProgramIds(participantId: number, db: DbClient = prisma): Promise<number[]> {
    const [participantPrograms, volunteerPrograms, leadPrograms] = await Promise.all([
        db.programParticipant.findMany({
            where: { personId: participantId },
            select: { programId: true }
        }),
        db.programVolunteer.findMany({
            where: { personId: participantId },
            select: { programId: true }
        }),
        db.program.findMany({
            where: { leadMentorId: participantId },
            select: { id: true }
        }),
    ]);

    return [
        ...participantPrograms.map(p => p.programId),
        ...volunteerPrograms.map(v => v.programId),
        ...leadPrograms.map(p => p.id)
    ];
}

/**
 * Finds the most relevant event for a participant at a given time.
 * Logic:
 * 1. Checks what programs the participant is enrolled in (or volunteering for).
 * 2. Looks for an event in those programs that is currently ongoing or starting within 4 hours.
 */
export async function findAssociatedEventAt(participantId: number, targetTime: Date, db: DbClient = prisma): Promise<number | null> {
    // A target event can be one that is currently ongoing OR starting within 4 hours of targetTime
    const timePlus4Hours = new Date(targetTime.getTime() + 4 * 60 * 60 * 1000);

    const relevantProgramIds = await getRelevantProgramIds(participantId, db);

    if (relevantProgramIds.length === 0) {
        return null;
    }

    // Find the soonest matching event in these programs
    const matchingEvent = await db.event.findFirst({
        where: {
            programId: { in: relevantProgramIds },
            // Event must either overlap with targetTime, or start within 4 hours of targetTime
            OR: [
                // Ongoing: startAt <= targetTime <= endAt
                {
                    startAt: { lte: targetTime },
                    endAt: { gte: targetTime }
                },
                // Upcoming: targetTime < startAt <= targetTime + 4h
                {
                    startAt: {
                        gt: targetTime,
                        lte: timePlus4Hours
                    }
                }
            ]
        },
        orderBy: { startAt: 'asc' }
    });

    return matchingEvent ? matchingEvent.id : null;
}

/**
 * Processes a checkout. It takes an open visit and a checkout time, and creates multiple
 * visits if the user was enrolled in back-to-back events during their stay.
 *
 * The departure is capped at `arrivedAt + MAX_VISIT_MS`. A caller that took a
 * typed time has already rejected anything longer, so the cap only ever bites
 * on a stamped-now close — where the alternative is a record no human path
 * would have been allowed to write.
 *
 * It returns the final list of visits spanning their arrival to departure.
 */
export async function processVisitCheckout(visitId: number, checkoutTime: Date, db: DbClient = prisma, source: "SCANNER" | "TYPED" | "AUTO_CLOSE") {
    const originalVisit = await db.visit.findUnique({
        where: { id: visitId }
    });

    if (!originalVisit || originalVisit.departedAt || originalVisit.deletedAt) {
        return []; // Already checked out, tombstoned, or doesn't exist
    }

    // Chunks recreated below are all segments of one physical visit: they keep
    // the original arrival's source and take `source` as their departure channel.
    const { personId: participantId, arrivedAt, arrivedVia } = originalVisit;

    // Cap the whole span, before the event lookup, so every chunk boundary below
    // derives from the capped departure and the segments still sum to one visit.
    const departure = new Date(Math.min(checkoutTime.getTime(), arrivedAt.getTime() + MAX_VISIT_MS));

    const relevantProgramIds = await getRelevantProgramIds(participantId, db);

    if (relevantProgramIds.length === 0) {
        // No programs enrolled, just close the visit normally
        const closed = await db.visit.update({
            where: { id: visitId },
            data: { departedAt: departure, departedVia: source }
        });
        invalidateAttendanceCache();
        return [closed];
    }

    // Find all events in these programs that fall between arrival and departure
    const eventsDuringStay = await db.event.findMany({
        where: {
            programId: { in: relevantProgramIds },
            // An event overlaps if it starts before checkout time AND ends after arrival time
            startAt: { lt: departure },
            endAt: { gt: arrivedAt }
        },
        orderBy: { startAt: 'asc' }
    });

    if (eventsDuringStay.length === 0) {
        // No relevant events during their stay, just close normally
        const closed = await db.visit.update({
            where: { id: visitId },
            data: { departedAt: departure, departedVia: source }
        });
        invalidateAttendanceCache();
        return [closed];
    }

    // We have at least one event. We need to chunk the visit by deleting the
    // original open visit and recreating the chunks atomically.
    const chunk = async (tx: TxClient) => {
        // First, delete the original open visit
        await tx.visit.delete({
            where: { id: visitId }
        });

        const createdVisits = [];
        let currentIterStart = arrivedAt;

        for (let i = 0; i < eventsDuringStay.length; i++) {
            const event = eventsDuringStay[i];
            const nextEvent = eventsDuringStay[i + 1];

            // If there's a gap between current time and the event start time,
            // create an unassociated visit for the gap time
            if (currentIterStart < event.startAt) {
                const gapEnd = event.startAt < departure ? event.startAt : departure;
                if (currentIterStart < gapEnd) {
                    createdVisits.push(await tx.visit.create({
                        data: {
                            personId: participantId,
                            arrivedAt: currentIterStart,
                            departedAt: gapEnd,
                            arrivedVia,
                            departedVia: source,
                            associatedEventId: null
                        }
                    }));
                }
                currentIterStart = gapEnd;
            }

            // If we've reached checkout time before the event logic starts, break.
            if (currentIterStart >= departure) {
                break;
            }

            // Create visit associated with the event
            // The boundaries are constrained by arrival, checkout, and event boundaries
            const eventVisitStart = currentIterStart > event.startAt ? currentIterStart : event.startAt;

            // Check out when the next event starts, or when they physically leave
            let eventVisitEnd = departure;
            if (nextEvent && nextEvent.startAt < departure) {
                eventVisitEnd = nextEvent.startAt;
            }

            if (eventVisitStart < eventVisitEnd) {
                createdVisits.push(await tx.visit.create({
                    data: {
                        personId: participantId,
                        arrivedAt: eventVisitStart,
                        departedAt: eventVisitEnd,
                        arrivedVia,
                        departedVia: source,
                        associatedEventId: event.id
                    }
                }));
            }
            currentIterStart = eventVisitEnd;
        }

        // If there is still remaining time after the last event until checkOut time, create one last unassociated visit
        if (currentIterStart < departure) {
            createdVisits.push(await tx.visit.create({
                data: {
                    personId: participantId,
                    arrivedAt: currentIterStart,
                    departedAt: departure,
                    arrivedVia,
                    departedVia: source,
                    associatedEventId: null
                }
            }));
        }

        return createdVisits;
    };

    // If we were handed a transaction client (caller already opened one — e.g.
    // the scan route's per-participant lock), run the chunking on it directly:
    // Postgres has no nested transactions and the tx client has no `$transaction`.
    // Otherwise open our own transaction so the delete + recreates stay atomic.
    const created = await withTx(db, chunk);
    invalidateAttendanceCache();
    return created;
}
