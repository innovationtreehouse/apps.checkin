import { logger } from "@/lib/logger";
import { finishRun, inRun, newRun, runCrashed } from "@/lib/finishRun";
import { handler } from "@/security/handler";
import { settleApplicationsAwaitingCheck } from "@/lib/membership/settleHouseholdBg";

/** The run ledger's name for this job: the route's last path segment. */
const JOB = "bg-settle";

/**
 * GET /api/cron/bg-settle — daily household background-check catch-up: settles every
 * household application waiting on its check, opening a check review for one with
 * consent and none open. Idempotent. Answers only to BG_SETTLE_CRON_SECRET (registry
 * `cronSecret`). Counts go to the log and the run ledger; the response body is `{}`.
 */
export const GET = handler("GET /api/cron/bg-settle", async () => {
    const startedAt = new Date();
    const run = newRun();
    try {
        const settled = await inRun(run, settleApplicationsAwaitingCheck);
        logger.info(`[bg-settle] ${JSON.stringify(settled)}`);
        await finishRun(JOB, startedAt, true, settled.failed > 0 ? `${settled.failed} item(s) failed` : undefined, run);
        return {};
    } catch (err) {
        runCrashed(run, JOB, err);
        await finishRun(JOB, startedAt, false, err, run);
        throw err;
    }
});
