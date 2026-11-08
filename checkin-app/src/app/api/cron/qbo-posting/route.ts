import { logger } from "@/lib/logger";
import { finishRun, inRun, laneReached, newRun, stepCrashed } from "@/lib/finishRun";
import { getOrg } from "@/lib/components/host";
import { handler } from "@/security/handler";
import { runExpenseQbPosting } from "@checkin/expense";
import { runDonationDepositHandOver, runInKindQbPosting } from "@checkin/bulk-donation";
import { drainIncomeOutbox, runIncomeOrphanSweep } from "@checkin/income";

/** The run ledger's name for this job: the route's last path segment. */
const JOB = "qbo-posting";

/** The counts of a drain that ran: whether its duplicate check could read QuickBooks. No drain stops on failures. */
type DrainRun = { sweep: { full: boolean } | { failed: true } };

/** `lane` is the drain's lane as the run names it: the drain ran, so the run reached it. */
function drainProblems(label: string, lane: string, drain: DrainRun): string[] {
    laneReached(lane);
    return "failed" in drain.sweep ? [`${label} duplicate check`] : [];
}

/**
 * Daily QuickBooks posting: expense's step (stranded recovery, the outbox drain, the drift check, the
 * retry of outcome emails still owed),
 * then donation handing completed disbursements to income, then the in-kind drain, then income's drain (reconcile, then the outbox), then income's orphan sweep. Answers only to QBO_POSTING_CRON_SECRET (registry `cronSecret`).
 *
 * Each step is isolated, so one failing never stops the other; a failed step is recorded on the
 * run as its error. So is a duplicate check that could not read QuickBooks, and an in-kind lane
 * missing a books-map role while gifts wait. The run ends in finishRun, which
 * hands the lanes' kinded failures to the incident engine. Counts go to the log only; the
 * response body is `{}`.
 */
/** Every step, each isolated; returns what failed. */
async function postAll(): Promise<string[]> {
    const failed: string[] = [];

    try {
        const expense = await runExpenseQbPosting();
        logger.info(`[qbo-posting] expense ${JSON.stringify(expense)}`);
        failed.push(...expense.failedParts.map((part) => `expense ${part}`));
        if (typeof expense.qbPost === "object" && !("error" in expense.qbPost)) failed.push(...drainProblems("expense", "expense posting", expense.qbPost));
    } catch (err) {
        logger.error("[qbo-posting] expense QuickBooks posting failed:", err);
        stepCrashed(JOB, "expense", err, ["expense posting"]);
        failed.push("expense");
    }
    try {
        logger.info(`[qbo-posting] donation hand-over ${JSON.stringify(await runDonationDepositHandOver((await getOrg()).id))}`);
    } catch (err) {
        logger.error("[qbo-posting] donation hand-over to income failed:", err);
        stepCrashed(JOB, "donation", err);
        failed.push("donation");
    }
    try {
        const inKind = await runInKindQbPosting((await getOrg()).id);
        logger.info(`[qbo-posting] in-kind ${JSON.stringify(inKind)}`);
        if (typeof inKind === "object") {
            if ("unconfigured" in inKind) {
                if (inKind.waiting > 0) failed.push("in-kind unconfigured");
            } else failed.push(...drainProblems("in-kind", "bulk-donation in-kind-posting", inKind));
        }
    } catch (err) {
        logger.error("[qbo-posting] in-kind QuickBooks posting failed:", err);
        stepCrashed(JOB, "in-kind", err, ["bulk-donation in-kind-posting"]);
        failed.push("in-kind");
    }
    try {
        const income = await drainIncomeOutbox((await getOrg()).id);
        logger.info(`[qbo-posting] income ${JSON.stringify(income)}`);
        if (typeof income.post === "object") laneReached("income deposit-build");
    } catch (err) {
        logger.error("[qbo-posting] income QuickBooks posting failed:", err);
        stepCrashed(JOB, "income", err, ["income deposit-build"]);
        failed.push("income");
    }
    try {
        logger.info(`[qbo-posting] income sweep ${JSON.stringify(await runIncomeOrphanSweep((await getOrg()).id))}`);
    } catch (err) {
        logger.error("[qbo-posting] income orphan sweep failed:", err);
        stepCrashed(JOB, "income sweep", err);
        failed.push("income sweep");
    }

    return failed;
}

export const GET = handler("GET /api/cron/qbo-posting", async () => {
    const startedAt = new Date();
    const run = newRun();
    const failed = await inRun(run, postAll);
    await finishRun(JOB, startedAt, true, failed.length ? `failed: ${failed.join(", ")}` : undefined, run);
    return {};
});
