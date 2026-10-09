import { NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import { withCron } from "@/lib/cronAuth";
import prisma from "@/lib/prisma";
import { processPostEventEmails } from "@/lib/postEventEmails";
import { processVisitCheckout } from "@/lib/attendanceTransitions";
import { type DepartureChange, logCloseDepartures } from "@/lib/scan-service";
import { LIVE_PERSON } from "@/lib/person/filters";
import { LIVE_VISIT } from "@/lib/visit/filters";
import { runPersonAgreementSweep } from "@/lib/membership/personAgreementTriggers";
import { systemActor } from "@/lib/auditActor";
import { invalidateAttendanceCache } from "@/lib/getFullAttendance";

export const GET = withCron(async () => {
        const now = new Date();

        // 1. Find all users who are currently checked in (abandoned visits)
        // A tombstoned open visit is not abandoned — it's deleted; closing it
        // would rewrite a record the member chose to erase.
        const abandonedVisits = await prisma.visit.findMany({
            where: {
                departedAt: null,
                ...LIVE_VISIT
            },
            include: {
                person: true
            }
        });

        let checkedOutCount = 0;
        let failed = 0;
        let boardNotified = false;

        if (abandonedVisits.length > 0) {
            // The sweep is a facility close with no person behind it.
            const close = await prisma.facilityClose.create({
                data: { closedAt: now, closedById: null, via: "NIGHTLY_SWEEP" },
                select: { id: true },
            });
            // Force everybody out concurrently. One bad checkout must not abort the rest,
            // so each visit's checkout and its departure logs commit together, alone.
            const results = await Promise.allSettled(
                // AUTO_CLOSE: stamped at cron-run time, so the member's real leave
                // may be hours earlier. Correcting one of these is expected by
                // construction and never flags (lib/visit/significance.ts).
                abandonedVisits.map((visit) => prisma.$transaction(async (tx) => {
                    // Empty: someone else departed the visit first, so this close set nothing.
                    const segments = await processVisitCheckout(visit.id, now, tx, "AUTO_CLOSE", close.id);
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
                    await logCloseDepartures(tx, close.id, systemActor("cron:nightly"), departures);
                    return segments;
                }))
            );
            // After every per-visit transaction commits: the checkout's own
            // invalidation runs inside the transaction, so a concurrent read
            // could refill the cache from the still-open rows.
            invalidateAttendanceCache();
            results.forEach((result, i) => {
                if (result.status === "fulfilled") {
                    checkedOutCount += 1;
                } else {
                    failed += 1;
                    const visit = abandonedVisits[i];
                    logger.error(`Failed to check out visit ${visit.id} (person ${visit.person.email}):`, result.reason);
                }
            });

            // If at least one was a isKeyholder, the facility was left "Open". We need to alert the board.
            const abandonedKeyholders = abandonedVisits.filter(v => v.person.isKeyholder);
            
            if (abandonedKeyholders.length > 0) {
                const boardMembers = await prisma.person.findMany({
                    where: { isBoardMember: true, ...LIVE_PERSON },
                    select: { email: true }
                });

                const keyholderNames = abandonedKeyholders.map(v => v.person.name || v.person.email).join(', ');

                // System Audit Log for the violation
                await prisma.auditLog.create({
                    data: {
                        ...systemActor("cron:nightly"),
                        action: 'CREATE',
                        tableName: 'SYSTEM_NOTIFY',
                        affectedEntityId: 0,
                        newData: { message: `Auto-closed facility at midnight. Abandoned keyholders: ${keyholderNames}` } as unknown as never
                    }
                });

                logger.info(`CRITICAL NOTIFICATION TO BOARD MEMBERS (${boardMembers.map(m => m.email).join(', ')}):`);
                logger.info(`Facility was auto-closed by the nightly cron. The following keyholders failed to badge out: ${keyholderNames}`);
                
                boardNotified = true;
            }
        }

        // 2. Process all pending post-event emails immediately, regardless of 1-hour delay
        const emailResult = await processPostEventEmails({ forceImmediate: true });

        // 3. #1165: delete DoB for anyone who has crossed 26 since the last run. No
        // age-gated program can target anyone over 25 (MAX_PROGRAM_AGE), so a DoB for
        // a 26+ person is dead weight on our most-sensitive field. Strip it and set the
        // declared-adult flag so age gates / search / UI still see them as an adult.
        // The #1165 backfill migration did the one-time sweep; this keeps it clean as
        // members age in. Raw SQL so age is judged in the DB, tombstones included.
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
                checkedOutCount,
                boardNotified
            },
            postEvents: emailResult,
            adultDobPurged,
            personAgreements
        });
});
