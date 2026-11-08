import { logger } from "@/lib/logger";
import { cronJobName, recordCronRun } from "@/lib/cronRuns";
import { getOrg } from "@/lib/components/host";
import { handler } from "@/security/handler";
import { runExpenseQbPosting } from "@checkin/expense";
import { runDonationDepositHandOver, runInKindQbPosting } from "@checkin/bulk-donation";
import { drainIncomeOutbox, runIncomeOrphanSweep } from "@checkin/income";

/**
 * The counts of a drain that ran: how it stopped, and whether its duplicate check could read
 * QuickBooks. Expense says a connection stop with `stoppedOnConnection`; in-kind says every stop's
 * kind with `stopKind`, and sets `stoppedAfterFailures` for each.
 */
type DrainRun = {
    stoppedAfterFailures: boolean;
    stoppedOnConnection?: boolean;
    stopKind?: string | null;
    refusalStop: { code: string } | null;
    sweep: { full: boolean } | { failed: true };
};

function stopProblem(lane: string, drain: DrainRun): string | null {
    if (drain.refusalStop) return `${lane} refusal stop (code ${drain.refusalStop.code})`;
    if (drain.stoppedOnConnection || drain.stopKind === "connection") return `${lane} connection stop`;
    return drain.stoppedAfterFailures ? `${lane} streak stop` : null;
}

function drainProblems(lane: string, drain: DrainRun): string[] {
    const problems: string[] = [];
    const stop = stopProblem(lane, drain);
    if (stop) problems.push(stop);
    if ("failed" in drain.sweep) problems.push(`${lane} duplicate check`);
    return problems;
}

/**
 * Daily QuickBooks posting: expense's step (stranded recovery, the outbox drain, the drift check, the
 * retry of outcome emails still owed),
 * then donation handing completed disbursements to income, then the in-kind drain, then income's drain (reconcile, then the outbox), then income's orphan sweep. Answers only to QBO_POSTING_CRON_SECRET (registry `cronSecret`).
 *
 * Each step is isolated, so one failing never stops the other; a failed step is recorded on the
 * run as its error. So is a drain stopped by its failure streak, a broken QuickBooks connection or
 * a fault code QuickBooks refused three times; a duplicate check that could not read QuickBooks;
 * and an in-kind lane missing a books-map role while gifts wait. Counts go to the log only; the
 * response body is `{}`.
 */
export const GET = handler("GET /api/cron/qbo-posting", async ({ req }) => {
    const startedAt = new Date();
    const failed: string[] = [];

    try {
        const expense = await runExpenseQbPosting();
        logger.info(`[qbo-posting] expense ${JSON.stringify(expense)}`);
        failed.push(...expense.failedParts.map((part) => `expense ${part}`));
        if (typeof expense.qbPost === "object" && !("error" in expense.qbPost)) failed.push(...drainProblems("expense", expense.qbPost));
    } catch (err) {
        logger.error("[qbo-posting] expense QuickBooks posting failed:", err);
        failed.push("expense");
    }
    try {
        logger.info(`[qbo-posting] donation hand-over ${JSON.stringify(await runDonationDepositHandOver((await getOrg()).id))}`);
    } catch (err) {
        logger.error("[qbo-posting] donation hand-over to income failed:", err);
        failed.push("donation");
    }
    try {
        const inKind = await runInKindQbPosting((await getOrg()).id);
        logger.info(`[qbo-posting] in-kind ${JSON.stringify(inKind)}`);
        if (typeof inKind === "object") {
            if ("unconfigured" in inKind) {
                if (inKind.waiting > 0) failed.push("in-kind unconfigured");
            } else failed.push(...drainProblems("in-kind", inKind));
        }
    } catch (err) {
        logger.error("[qbo-posting] in-kind QuickBooks posting failed:", err);
        failed.push("in-kind");
    }
    try {
        logger.info(`[qbo-posting] income ${JSON.stringify(await drainIncomeOutbox((await getOrg()).id))}`);
    } catch (err) {
        logger.error("[qbo-posting] income QuickBooks posting failed:", err);
        failed.push("income");
    }
    try {
        logger.info(`[qbo-posting] income sweep ${JSON.stringify(await runIncomeOrphanSweep((await getOrg()).id))}`);
    } catch (err) {
        logger.error("[qbo-posting] income orphan sweep failed:", err);
        failed.push("income sweep");
    }

    await recordCronRun(cronJobName(req.url), startedAt, true, failed.length ? `failed: ${failed.join(", ")}` : undefined);
    return {};
});
