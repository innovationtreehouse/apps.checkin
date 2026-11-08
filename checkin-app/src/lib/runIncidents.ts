import { getCronJobStatuses } from "@/lib/cronRuns";
import { sendTemplated } from "@/lib/email-templates/send";
import { logger } from "@/lib/logger";
import { evaluateIncidents, purgeClosedIncidents, type RunReport } from "@/lib/opsIncidents";
import prisma from "@/lib/prisma";
import { APP_TIMEZONE } from "@/lib/time";

/** An address setting as recipients. Unset means nobody: the engine sends nothing and tries again next run. */
function recipients(address: string | null | undefined): string[] {
    const trimmed = address?.trim();
    return trimmed ? [trimmed] : [];
}

/**
 * Applies one job run to the incident engine, adding every job with no successful run in 48
 * hours, and sends what the engine owes to the alert and Board address settings. Never throws:
 * a failed evaluation must not change the job's own outcome.
 */
export async function evaluateRun(report: Omit<RunReport, "staleJobs">): Promise<void> {
    try {
        const [jobs, settings] = await Promise.all([
            getCronJobStatuses(),
            prisma.boardSettings.findUnique({ where: { id: 1 }, select: { alertEmailAddress: true, boardEmailAddress: true } }),
        ]);
        await evaluateIncidents({ ...report, staleJobs: jobs.filter((j) => j.stale).map((j) => j.job) }, {
            send: (to, template, ctx) => sendTemplated(template, to, ctx),
            alertTo: recipients(settings?.alertEmailAddress),
            boardTo: recipients(settings?.boardEmailAddress),
            timeZone: APP_TIMEZONE,
        });
        await purgeClosedIncidents();
    } catch (err) {
        logger.error("[ops incident] run evaluation failed:", err);
    }
}
