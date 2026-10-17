import { NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import { withCron } from "@/lib/cronAuth";
import prisma from "@/lib/prisma";
import { withdrawAndReleaseHold } from "@/lib/program/capacity";
import { STATES } from "@/lib/programs/enrollmentState";
import { systemActor } from "@/lib/auditActor";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * GET /api/cron/scholarship-grace-expiry — release path (c) of the
 * scholarship hold ledger (product decision 2026-07-06). A denied applicant
 * keeps their held seat (denial performs no Shopify op — see the refuse
 * route) so they can still pay; this sweep is the backstop for the ones who
 * never pay and never withdraw. Once BoardSettings.scholarshipDenialGraceDays
 * has elapsed since the denial, the participant is auto-withdrawn and the
 * seat released (+1) — reusing the exact withdrawal path self/admin removal
 * uses (withdrawAndReleaseHold), so this is "auto-withdrawal + seat restore",
 * not a bespoke release. They can re-enroll afterward if seats remain.
 *
 * NULL scholarshipDenialGraceDays = the feature is OFF; the sweep no-ops
 * entirely (never guesses a default). Authorized by
 * `Authorization: Bearer $CRON_SECRET` (see lib/cronAuth.ts).
 */
export const GET = withCron(async () => {
    const settings = await prisma.boardSettings.findUnique({ where: { id: 1 } });
    const graceDays = settings?.scholarshipDenialGraceDays;
    if (graceDays === null || graceDays === undefined) {
        return NextResponse.json({ success: true, enabled: false, processed: 0, released: 0 });
    }

    const cutoff = new Date(Date.now() - graceDays * DAY_MS);
    const expired = await prisma.programParticipant.findMany({
        where: {
            // This sweep owns exactly the PENDING_HELD_DENIED state (enrollmentState
            // §3); consume its `where` and add the grace cutoff onto the denial stamp.
            ...STATES.PENDING_HELD_DENIED.where,
            paymentPlanDeniedAt: { not: null, lte: cutoff },
        },
        include: { program: true, person: true },
    });

    let released = 0;
    let failed = 0;
    for (const record of expired) {
        try {
            const { released: didRelease } = await withdrawAndReleaseHold(record.programId, record.personId, record.program);
            if (didRelease) released++;

            await prisma.auditLog.create({
                data: {
                    ...systemActor("cron:scholarship-grace-expiry"),
                    action: "DELETE",
                    tableName: "ProgramParticipant",
                    affectedEntityId: record.personId,
                    secondaryAffectedEntity: record.programId,
                    // Distinct context from a manual withdrawal's audit entry — this
                    // one is system-driven, so it's discoverable as a grace expiry.
                    newData: { reason: "scholarship_grace_expired", graceDays, paymentPlanDeniedAt: record.paymentPlanDeniedAt },
                },
            });

            logger.info(`[CRON] Auto-withdrew ${record.person.name} from ${record.program.name} — scholarship denial grace period (${graceDays}d) expired.`);
        } catch (err) {
            // Isolate one bad row from the rest of the sweep.
            failed++;
            logger.error(`[CRON] Failed to process grace-expiry for participant ${record.personId} in program ${record.programId}:`, err);
        }
    }

    // `failed` is the run-health signal withCron reads: isolating a bad row keeps
    // the sweep going and the run still counts as having RUN, but it is not clean,
    // so withCron records it with an error rather than silently green.
    return NextResponse.json({ success: true, enabled: true, processed: expired.length, released, failed });
});
