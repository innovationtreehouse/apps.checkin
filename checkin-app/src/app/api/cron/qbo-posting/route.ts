import { logger } from "@/lib/logger";
import { cronJobName, recordCronRun } from "@/lib/cronRuns";
import { getOrg } from "@/lib/catalog/configure";
import { handler } from "@/security/handler";
import { runExpenseQbPosting } from "@checkin/expense";
import { runDonationQbPosting } from "@checkin/bulk-donation";
import { runIncomeOrphanSweep } from "@checkin/income";

/**
 * Daily QuickBooks posting: expense's step (stranded recovery, the outbox drain, the drift check),
 * then the bulk-donation drain, then income's orphan sweep. Answers only to QBO_POSTING_CRON_SECRET (registry `cronSecret`).
 *
 * Each step is isolated, so one failing never stops the other; a failed step is recorded on the
 * run as its error. Counts go to the log only; the response body is `{}`.
 */
export const GET = handler("GET /api/cron/qbo-posting", async ({ req }) => {
    const startedAt = new Date();
    const failed: string[] = [];

    try {
        logger.info(`[qbo-posting] expense ${JSON.stringify(await runExpenseQbPosting())}`);
    } catch (err) {
        logger.error("[qbo-posting] expense QuickBooks posting failed:", err);
        failed.push("expense");
    }
    try {
        logger.info(`[qbo-posting] donation ${JSON.stringify(await runDonationQbPosting((await getOrg()).id))}`);
    } catch (err) {
        logger.error("[qbo-posting] donation QuickBooks posting failed:", err);
        failed.push("donation");
    }
    try {
        logger.info(`[qbo-posting] income sweep ${JSON.stringify(await runIncomeOrphanSweep((await getOrg()).id))}`);
    } catch (err) {
        logger.error("[qbo-posting] income orphan sweep failed:", err);
        failed.push("income");
    }

    await recordCronRun(cronJobName(req.url), startedAt, true, failed.length ? `failed: ${failed.join(", ")}` : undefined);
    return {};
});
