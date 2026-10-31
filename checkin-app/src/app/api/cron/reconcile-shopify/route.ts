import { NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import { withCron } from "@/lib/cronAuth";
import { runReconcile } from "@/lib/finance/reconcile";
import { runSaleSweep } from "@/lib/programs/saleSweep";
import { runReconcile as runIncomeReconcile } from "@checkin/income";
import { getOrg } from "@/lib/components/host";
import { runExpenseCatchUp } from "@checkin/expense";
import { healProgramStock } from "@/lib/shopify/stock";
import { catchUpOrgEvents as catchUpInventoryEvents } from "@checkin/local-inventory";
import { catchUpOrgEvents as catchUpWorkflowEvents, sweepStuckApplying } from "@checkin/workflow-mapping";
import { readMailbox, repushUnpushed, resendDonorSync, sweepInterruptedOcr, sweepOutcomeNotices, sweepStuckUploaded } from "@checkin/receipt";

/** Runs one step so its failure stays its own: logged, and reported as `{ status: "error" }`. */
async function isolated<T>(name: string, failureName: string, step: () => Promise<T>): Promise<T | { status: "error" }> {
    let outcome: T | { status: "error" };
    try {
        outcome = await step();
    } catch (err) {
        logger.error(`[reconcile] ${failureName} failed:`, err);
        outcome = { status: "error" };
    }
    logger.info(`[reconcile] ${name} ${JSON.stringify(outcome)}`);
    return outcome;
}

/**
 * Daily Shopify reconciler — schedule at 09:15 UTC, ~15 min behind s-read's
 * 09:00 UTC sync (infra#129), so it reads a mirror that was just refreshed.
 *
 * DAILY, NOT HOURLY, and the cadence is a scale-to-zero constraint, not a taste
 * call: checkin and shopify_read share one Aurora cluster that auto-pauses at
 * min-capacity 0 after ~5 minutes with zero connections and zero queries. Every
 * run of this job opens connections and queries, i.e. WAKES that cluster — which
 * is exactly why infra#129 dropped s-read from hourly to daily. Running this
 * hourly would re-impose the cost that PR removes, and would re-read an unchanged
 * mirror 23 times out of 24. Sitting just behind s-read's sync piggybacks on the
 * wake s-read already causes (worst case one extra resume, absorbed by the
 * aurora-resume-retry extension — this is a background job, latency is free).
 *
 * The trade: a missed orders/paid webhook is recovered within ~24h rather than
 * ~1h. The reversal webhooks (api/webhooks/shopify/reversals) are the
 * low-latency path; this is the guaranteed backstop.
 *
 * Recovers missed orders/paid webhooks (advancing families past the paid
 * checkpoint) and raises refund/chargeback/cancel problems for the board. See
 * lib/finance/reconcile/. No-op when the mirror isn't wired
 * (config.shopifyReadDatabaseUrl() null — no SHOPIFY_READ_DB / override set).
 *
 * Also runs the program-sale sweep (lib/programs/saleSweep.ts): ends sales whose
 * off-sale date has arrived and emails the board unpaid claims a week later.
 *
 * Then matches paid payouts to QuickBooks deposits (the income library) on the
 * same fresh mirror. That step is isolated: its failure never fails checkin's
 * reconcile, and the response carries its counts only, no payout ids or amounts.
 *
 * Then runs the expense library's catch-up (intake replay, catalog events). Its failure never
 * fails checkin's reconcile; counts only. QuickBooks posting runs from api/cron/qbo-posting.
 *
 * Then re-pushes program stock the stock writer left owing (healProgramStock),
 * which needs no mirror. Isolated the same way.
 *
 * Then replays catalog events that local-inventory and workflow-mapping missed (a consumer that
 * threw during the catalog's post-commit call-out); local-inventory's step also merges stock for
 * pending provisionals the catalog has since resolved. Each step is isolated; counts only. A
 * provisional that could not be merged counts toward the top-level `failed`.
 *
 * Then re-pushes workflow-mapping receipts left `applying` with no live push (sweepStuckApplying).
 * Isolated the same way; counts only.
 *
 * Then the receipt library's catch-up step moves receipts stranded mid-OCR to
 * `ocr_failed`. Isolated the same way; the response carries its count only.
 *
 * Then moves receipts whose intake checks never ran out of `uploaded` into finance's
 * `flow_error` queue (sweepStuckUploaded). Isolated the same way; counts only.
 *
 * Then re-sends finalized receipts that workflow-mapping has not received yet (S1). Isolated the
 * same way; counts only.
 *
 * Then it re-sends in-kind donor changes the receipt library has not yet delivered to
 * donations (resendDonorSync). Isolated the same way; counts only, no donor data.
 *
 * Then it reads the receipt mailbox (readMailbox), the only slow step: one OCR call per new
 * file, capped per run. Isolated the same way; counts only, "unbound" when no mailbox is set. A run
 * that could not read the mailbox counts toward the top-level `failed`, so the cron run records it.
 *
 * Last, it retries the receipt outcome emails still owed (sweepOutcomeNotices). Isolated the same
 * way; counts only.
 */
export const GET = withCron(async () => {
    const result = await runReconcile();
    logger.info(`[reconcile] ${JSON.stringify(result)}`);
    const saleSweep = await runSaleSweep();
    logger.info(`[sale-sweep] ${JSON.stringify(saleSweep)}`);
    const income = await isolated("income", "income reconciliation", async () => runIncomeReconcile((await getOrg()).id));
    const expense = await isolated("expense", "expense catch-up", runExpenseCatchUp);
    const programStock = await isolated("program stock", "program stock heal", healProgramStock);
    const inventoryEvents = await isolated("inventory events", "inventory event catch-up", catchUpInventoryEvents);
    const workflowEvents = await isolated("workflow-mapping events", "workflow-mapping event catch-up", catchUpWorkflowEvents);
    const receivingApply = await isolated("workflow-mapping stuck applies", "workflow-mapping stuck-apply sweep", sweepStuckApplying);
    const receipt = await isolated("receipt", "receipt catch-up", sweepInterruptedOcr);
    const receiptStuck = await isolated("receipt stuck uploads", "receipt stuck-upload sweep", sweepStuckUploaded);
    const receiptPush = await isolated("receipt push", "receipt re-push", repushUnpushed);
    const donorSync = await isolated("donor sync", "receipt donor re-send", resendDonorSync);
    const receiptMail = await isolated("receipt mail", "receipt mail intake", readMailbox);
    const receiptOutcomes = await isolated("receipt outcome emails", "receipt outcome emails", sweepOutcomeNotices);
    const mailUnread = receiptMail.status === "error" || receiptMail.status === "listing_failed";
    const sweepRowsFailed = [receipt, receiptStuck].reduce((sum, sweep) => sum + ("failed" in sweep ? sweep.failed : 0), 0);
    const reconcileFailed = "reconcileFailed" in inventoryEvents ? inventoryEvents.reconcileFailed : 0;
    return NextResponse.json({ success: true, ...result, failed: result.failed + sweepRowsFailed + reconcileFailed + (mailUnread ? 1 : 0), saleSweep, income, expense, programStock, inventoryEvents, workflowEvents, receivingApply, receipt, receiptStuck, receiptPush, donorSync, receiptMail, receiptOutcomes });
});
