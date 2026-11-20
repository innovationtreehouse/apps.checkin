import { logger } from "@/lib/logger";
import { finishRun, inRun, newRun, reportTo, stepCrashed } from "@/lib/finishRun";
import { getOrg } from "@/lib/components/host";
import { handler } from "@/security/handler";
import { runDonationDepositHandOver } from "@checkin/bulk-donation";
import { runIncomeOrphanSweep } from "@checkin/income";
import { refreshQuickBooksLists } from "@/lib/finance/quickBooksLists";
import { requestPostingRun, runPostingQueue, type PostingLane } from "@/lib/finance/quickBooksPosting";
import { currentPostingWarnings } from "@/lib/finance/postingRuns";

/** The run ledger's name for this job: the route's last path segment. */
const JOB = "qbo-posting";

/** The counts of a drain that ran: whether its duplicate check could read QuickBooks. No drain stops on failures. */
type DrainRun = { sweep: { full: boolean } | { failed: true } };

function drainProblems(label: string, drain: DrainRun): string[] {
    return "failed" in drain.sweep ? [`${label} duplicate check`] : [];
}

/** Runs `lane` under the posting slot to its end; null when another run holds the slot (the lane is queued or already running). */
async function inSlot<L extends PostingLane>(lane: L) {
    const run = await requestPostingRun(lane, null);
    if (run.status === "started") return run.done;
    logger.info(`[qbo-posting] ${lane} ${run.status}; the slot is held by ${run.slot.heldBy ?? "nobody"}`);
    return null;
}

/**
 * Daily QuickBooks posting: first the refresh of the app's copy of QuickBooks' account and Class lists, then expense's step (stranded recovery, the outbox drain, the drift check, the
 * retry of outcome emails still owed),
 * then donation handing completed disbursements to income, then the in-kind drain, then income's drain (reconcile, then the outbox), then income's orphan sweep, then any lane still queued for the posting slot, then the lanes' posting warnings (a lane throttled three runs in a row, or a run that lapsed holding the slot), each a failure of the run.
 * The expense, in-kind and income steps each take the posting slot, so a finance catch-up queued meanwhile runs between them. Answers only to QBO_POSTING_CRON_SECRET (registry `cronSecret`).
 *
 * Each step is isolated, so one failing never stops the other; a failed step is recorded on the
 * run as its error. So is a duplicate check that could not read QuickBooks, and an in-kind lane
 * missing a books-map role while gifts wait. The run ends in finishRun, which records it
 * with the lanes' failures by kind. Counts go to the log only; the
 * response body is `{}`.
 */
/** Every step, each isolated; returns what failed. */
async function postAll(): Promise<string[]> {
    const failed: string[] = [];

    try {
        const lists = await refreshQuickBooksLists();
        logger.info(`[qbo-posting] lists ${JSON.stringify(lists ?? "unbound")}`);
    } catch (err) {
        logger.error("[qbo-posting] QuickBooks list refresh failed:", err);
        stepCrashed(JOB, "lists", err, ["quickbooks lists-refresh"]);
        failed.push("lists");
    }
    try {
        const expense = await inSlot("expense");
        if (expense) {
            logger.info(`[qbo-posting] expense ${JSON.stringify(expense)}`);
            failed.push(...expense.failedParts.map((part) => `expense ${part}`));
            if (typeof expense.qbPost === "object" && !("error" in expense.qbPost)) failed.push(...drainProblems("expense", expense.qbPost));
        }
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
        const inKind = await inSlot("in-kind");
        if (inKind) logger.info(`[qbo-posting] in-kind ${JSON.stringify(inKind)}`);
        if (inKind && typeof inKind === "object") {
            if ("unconfigured" in inKind) {
                if (inKind.waiting > 0) failed.push("in-kind unconfigured");
            } else failed.push(...drainProblems("in-kind", inKind));
        }
    } catch (err) {
        logger.error("[qbo-posting] in-kind QuickBooks posting failed:", err);
        stepCrashed(JOB, "in-kind", err, ["bulk-donation in-kind-posting"]);
        failed.push("in-kind");
    }
    try {
        const income = await inSlot("income");
        if (income) logger.info(`[qbo-posting] income ${JSON.stringify(income)}`);
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
    try {
        await runPostingQueue();
    } catch (err) {
        logger.error("[qbo-posting] queued QuickBooks posting failed:", err);
        stepCrashed(JOB, "queue", err);
        failed.push("queue");
    }
    try {
        for (const { lane, cause, text } of await currentPostingWarnings()) {
            reportTo("quickbooks")({ lane: "posting-slot", kind: cause === "throttled" ? "connection" : "system", faultCodes: [`qb_${cause}`], detail: `${lane}: ${text}` });
            failed.push(`${lane} posting warning`);
        }
    } catch (err) {
        logger.error("[qbo-posting] reading the posting warnings failed:", err);
        stepCrashed(JOB, "warnings", err);
        failed.push("warnings");
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
