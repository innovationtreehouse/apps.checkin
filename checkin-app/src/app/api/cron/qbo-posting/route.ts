import { logger } from "@/lib/logger";
import { finishRun, inRun, laneStopped, newRun, stepCrashed } from "@/lib/finishRun";
import { getOrg } from "@/lib/components/host";
import { handler } from "@/security/handler";
import { runExpenseQbPosting } from "@checkin/expense";
import { runDonationDepositHandOver, runInKindQbPosting } from "@checkin/bulk-donation";
import { drainIncomeOutbox, runIncomeOrphanSweep } from "@checkin/income";

/** The run ledger's name for this job: the route's last path segment. */
const JOB = "qbo-posting";

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

/** `lane` is the drain's lane as the run names it; a stop marks it stopped. */
function drainProblems(label: string, lane: string, drain: DrainRun): string[] {
    const problems: string[] = [];
    const stop = stopProblem(label, drain);
    if (stop) {
        problems.push(stop);
        laneStopped(lane);
    }
    if ("failed" in drain.sweep) problems.push(`${label} duplicate check`);
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
 * and an in-kind lane missing a books-map role while gifts wait. The run ends in finishRun, which
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
        stepCrashed(JOB, "expense", err);
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
        stepCrashed(JOB, "in-kind", err);
        failed.push("in-kind");
    }
    try {
        logger.info(`[qbo-posting] income ${JSON.stringify(await drainIncomeOutbox((await getOrg()).id))}`);
    } catch (err) {
        logger.error("[qbo-posting] income QuickBooks posting failed:", err);
        stepCrashed(JOB, "income", err);
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
