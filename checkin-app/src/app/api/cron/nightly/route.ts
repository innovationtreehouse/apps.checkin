import { NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import { withCron } from "@/lib/cronAuth";
import prisma from "@/lib/prisma";
import { processPostEventEmails } from "@/lib/postEventEmails";
import { processVisitCheckout } from "@/lib/attendanceTransitions";
import { type DepartureChange, executePendingCloses, logCloseDepartures } from "@/lib/attendance/close";
import { LIVE_PERSON } from "@/lib/person/filters";
import { LIVE_VISIT } from "@/lib/visit/filters";
import { runPersonAgreementSweep } from "@/lib/membership/personAgreementTriggers";
import { systemActor } from "@/lib/auditActor";
import { invalidateAttendanceCache } from "@/lib/getFullAttendance";
import { lockFacility } from "@/lib/facilityLock";
import { duringNightlyRun } from "@/lib/attendance/nightlyClose";

/** A nightly run this soon after the last one is a retry of the same night. */
const SAME_NIGHT_MS = 12 * 60 * 60 * 1000;

export const GET = withCron(() => duringNightlyRun(async () => {
        // A keyholder's recorded close whose sweep never ran departs people at
        // the keyholder's time, so it runs before this sweep stamps them at now.
        await executePendingCloses();

        // 1. Find all users who are currently checked in (abandoned visits), and
        // record the sweep: a facility close with no person behind it. Recorded
        // every night, even with nobody open, because this row is what fences a
        // scan from before it that arrives later. The facility lock makes the read
        // and the close one step against a check-in: an arrival that commits
        // before it is read and swept, and one after it sees this close
        // (fenceReplayedArrival).
        const { now, close, abandonedVisits } = await prisma.$transaction(async (tx) => {
            await lockFacility(tx);
            const now = new Date();
            const sweptTonight = await tx.facilityClose.findFirst({
                where: { via: "NIGHTLY_SWEEP", closedAt: { gt: new Date(now.getTime() - SAME_NIGHT_MS) } },
                select: { id: true },
            });
            // A tombstoned open visit is not abandoned — it's deleted; closing it
            // would rewrite a record the member chose to erase.
            const abandonedVisits = await tx.visit.findMany({
                where: {
                    departedAt: null,
                    ...LIVE_VISIT
                },
                include: {
                    person: true
                }
            });
            // A retry's departures carry its own time, so they need their own close.
            const close = sweptTonight && abandonedVisits.length === 0 ? null : await tx.facilityClose.create({
                data: { closedAt: now, closedById: null, via: "NIGHTLY_SWEEP" },
                select: { id: true },
            });
            return { now, close, abandonedVisits };
        }, { maxWait: 5_000, timeout: 15_000 });

        let failed = 0;
        const forceClosed: typeof abandonedVisits = [];
        const stillOpen: typeof abandonedVisits = [];
        // "Notified" means a SYSTEM_NOTIFY audit row + log line; nothing emails the board.
        let boardNotified = false;

        if (close && abandonedVisits.length > 0) {
            const closeId = close.id;
            // One bad checkout must not abort the rest, so each visit's checkout and
            // its departure logs commit together, alone. Each takes the person lock
            // then the facility lock (the order every check-in path uses), so a
            // racing departure or close is serialized, not overwritten. Sequential:
            // concurrent transactions would only queue on the facility lock.
            for (const visit of abandonedVisits) {
                // AUTO_CLOSE: stamped at cron-run time, so the member's real leave
                // may be hours earlier. Correcting one of these is expected by
                // construction and never flags (lib/visit/significance.ts).
                try {
                    const segments = await prisma.$transaction(async (tx) => {
                        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${visit.personId})`;
                        await lockFacility(tx);
                        // Empty: someone else departed the visit first, so this close set nothing.
                        const segments = await processVisitCheckout(visit.id, now, tx, "AUTO_CLOSE", closeId);
                        // A visit split across events departs as several rows; each is logged.
                        const departures: DepartureChange[] = segments.flatMap((seg) => seg.departedAt && seg.departedVia ? [{
                            id: seg.id,
                            previousVisitId: visit.id,
                            personId: visit.personId,
                            oldDepartedAt: visit.departedAt,
                            oldDepartedVia: visit.departedVia,
                            departedAt: seg.departedAt,
                            departedVia: seg.departedVia,
                        }] : []);
                        await logCloseDepartures(tx, closeId, systemActor("cron:nightly"), departures, "NIGHTLY_SWEEP");
                        return segments;
                    });
                    if (segments.length > 0) forceClosed.push(visit);
                } catch (err) {
                    failed += 1;
                    stillOpen.push(visit);
                    logger.error(`Failed to check out visit ${visit.id} (person ${visit.person.email}):`, err);
                }
            }
            // After every per-visit transaction commits: the checkout's own
            // invalidation runs inside the transaction, so a concurrent read
            // could refill the cache from the still-open rows.
            invalidateAttendanceCache();

            // Every visit the sweep closed is a missed badge-out the board should see.
            // An abandoned keyholder means the facility was left open, so it is
            // reported even when its own checkout failed — but not when someone
            // else departed the visit before the sweep took the lock.
            const nameOf = (v: (typeof abandonedVisits)[number]) => v.person.name || v.person.email;
            const keyholderNames = [...forceClosed, ...stillOpen].filter(v => v.person.isKeyholder).map(nameOf).join(', ');
            const closedNames = forceClosed.map(nameOf).join(', ');

            if (closedNames || keyholderNames) {
                const boardMembers = await prisma.person.findMany({
                    where: { isBoardMember: true, ...LIVE_PERSON },
                    select: { email: true }
                });
                const message = `Auto-closed facility at midnight. Force-closed visits: ${closedNames || 'none'}.`
                    + (keyholderNames ? ` Abandoned keyholders: ${keyholderNames}.` : '');

                await prisma.auditLog.create({
                    data: {
                        ...systemActor("cron:nightly"),
                        action: 'CREATE',
                        tableName: 'SYSTEM_NOTIFY',
                        affectedEntityId: 0,
                        newData: { message } as unknown as never
                    }
                });

                logger.info(`NOTIFICATION TO BOARD MEMBERS (${boardMembers.map(m => m.email).join(', ')}): ${message}`);
                boardNotified = true;
            }
        }

        // 2. Process all pending post-event emails immediately, regardless of 1-hour delay
        const emailResult = await processPostEventEmails({ forceImmediate: true });

        // 3. Delete DoB for anyone who has crossed 26 since the last run. No
        // age-gated program can target anyone over 25 (MAX_PROGRAM_AGE), so a DoB for
        // a 26+ person is dead weight on our most-sensitive field. Strip it and set the
        // declared-adult flag so age gates / search / UI still see them as an adult.
        // Runs nightly to catch members as they age in. Raw SQL so age is judged in the DB, tombstones included.
        const purgedPeople = await prisma.$queryRaw<{ id: number }[]>`
            UPDATE "Person"
            SET "dateOfBirth" = NULL, "isDeclaredAdult" = true
            WHERE "dateOfBirth" IS NOT NULL
              AND "dateOfBirth" <= (CURRENT_DATE - INTERVAL '26 years')
            RETURNING "id"`;
        const adultDobPurged = purgedPeople.length;
        if (adultDobPurged > 0) {
            // The row records that a date of birth was removed, never the date
            // itself: retention forbids keeping it past 25, and an audit row
            // outlives the Person field it would be copied from.
            await prisma.auditLog.createMany({
                data: purgedPeople.map(({ id }) => ({
                    ...systemActor("cron:nightly"),
                    action: 'DELETE' as const,
                    tableName: 'Person',
                    affectedEntityId: id,
                    newData: { field: 'dateOfBirth', reason: 'aged_out_over_25' }
                }))
            });
            logger.info(`Nightly cron: purged DoB for ${adultDobPurged} member(s) now over 25 (#1165).`);
        }

        // 4. Open individual membership agreements for adult children (18-25,
        // non-lead, program-attached, in a member household). Runs nightly rather than
        // at the membership-year boundary because an annual pass misses everyone who
        // starts qualifying after it fires. Idempotent — one per person per cycle.
        const personAgreements = await runPersonAgreementSweep(now);
        if (personAgreements.opened > 0) {
            logger.info(`Nightly cron: opened ${personAgreements.opened} individual membership agreement(s).`);
        }

        return NextResponse.json({
            success: true,
            // Checkouts this run swallowed. withCron reads it and records the run
            // as completed-but-unclean when non-zero — a swept-nothing sweep is not
            // a green sweep, and is also not a sweep that failed to run.
            failed,
            facilityClose: {
                checkedOutCount: forceClosed.length,
                boardNotified
            },
            postEvents: emailResult,
            adultDobPurged,
            personAgreements
        });
}));
