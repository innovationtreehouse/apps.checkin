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
import { readMailbox, repushUnpushed, resendDonorSync, sweepInterruptedOcr, sweepStuckUploaded } from "@checkin/receipt";

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
 * pending provisionals the catalog has since resolved. Each step is isolated; counts only.
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
 * Last, it reads the receipt mailbox (readMailbox), the only slow step: one OCR call per new
 * file, capped per run. Isolated the same way; counts only, "unbound" when no mailbox is set.
 */
export const GET = withCron(async () => {
    const result = await runReconcile();
    logger.info(`[reconcile] ${JSON.stringify(result)}`);
    const saleSweep = await runSaleSweep();
    logger.info(`[sale-sweep] ${JSON.stringify(saleSweep)}`);
    let income: Awaited<ReturnType<typeof runIncomeReconcile>> | { status: "error" };
    try {
        income = await runIncomeReconcile((await getOrg()).id);
    } catch (err) {
        logger.error("[reconcile] income reconciliation failed:", err);
        income = { status: "error" };
    }
    logger.info(`[reconcile] income ${JSON.stringify(income)}`);
    let expense: Awaited<ReturnType<typeof runExpenseCatchUp>> | { status: "error" };
    try {
        expense = await runExpenseCatchUp();
    } catch (err) {
        logger.error("[reconcile] expense catch-up failed:", err);
        expense = { status: "error" };
    }
    logger.info(`[reconcile] expense ${JSON.stringify(expense)}`);
    let programStock: Awaited<ReturnType<typeof healProgramStock>> | { status: "error" };
    try {
        programStock = await healProgramStock();
    } catch (err) {
        logger.error("[reconcile] program stock heal failed:", err);
        programStock = { status: "error" };
    }
    logger.info(`[reconcile] program stock ${JSON.stringify(programStock)}`);
    let inventoryEvents: Awaited<ReturnType<typeof catchUpInventoryEvents>> | { status: "error" };
    try {
        inventoryEvents = await catchUpInventoryEvents();
    } catch (err) {
        logger.error("[reconcile] inventory event catch-up failed:", err);
        inventoryEvents = { status: "error" };
    }
    logger.info(`[reconcile] inventory events ${JSON.stringify(inventoryEvents)}`);
    let workflowEvents: Awaited<ReturnType<typeof catchUpWorkflowEvents>> | { status: "error" };
    try {
        workflowEvents = await catchUpWorkflowEvents();
    } catch (err) {
        logger.error("[reconcile] workflow-mapping event catch-up failed:", err);
        workflowEvents = { status: "error" };
    }
    logger.info(`[reconcile] workflow-mapping events ${JSON.stringify(workflowEvents)}`);
    let receivingApply: Awaited<ReturnType<typeof sweepStuckApplying>> | { status: "error" };
    try {
        receivingApply = await sweepStuckApplying();
    } catch (err) {
        logger.error("[reconcile] workflow-mapping stuck-apply sweep failed:", err);
        receivingApply = { status: "error" };
    }
    logger.info(`[reconcile] workflow-mapping stuck applies ${JSON.stringify(receivingApply)}`);
    let receipt: Awaited<ReturnType<typeof sweepInterruptedOcr>> | { status: "error" };
    try {
        receipt = await sweepInterruptedOcr();
    } catch (err) {
        logger.error("[reconcile] receipt catch-up failed:", err);
        receipt = { status: "error" };
    }
    logger.info(`[reconcile] receipt ${JSON.stringify(receipt)}`);
    let receiptStuck: Awaited<ReturnType<typeof sweepStuckUploaded>> | { status: "error" };
    try {
        receiptStuck = await sweepStuckUploaded();
    } catch (err) {
        logger.error("[reconcile] receipt stuck-upload sweep failed:", err);
        receiptStuck = { status: "error" };
    }
    logger.info(`[reconcile] receipt stuck uploads ${JSON.stringify(receiptStuck)}`);
    let receiptPush: Awaited<ReturnType<typeof repushUnpushed>> | { status: "error" };
    try {
        receiptPush = await repushUnpushed();
    } catch (err) {
        logger.error("[reconcile] receipt re-push failed:", err);
        receiptPush = { status: "error" };
    }
    logger.info(`[reconcile] receipt push ${JSON.stringify(receiptPush)}`);
    let donorSync: Awaited<ReturnType<typeof resendDonorSync>> | { status: "error" };
    try {
        donorSync = await resendDonorSync();
    } catch (err) {
        logger.error("[reconcile] receipt donor re-send failed:", err);
        donorSync = { status: "error" };
    }
    logger.info(`[reconcile] donor sync ${JSON.stringify(donorSync)}`);
    let receiptMail: Awaited<ReturnType<typeof readMailbox>> | { status: "error" };
    try {
        receiptMail = await readMailbox();
    } catch (err) {
        logger.error("[reconcile] receipt mail intake failed:", err);
        receiptMail = { status: "error" };
    }
    logger.info(`[reconcile] receipt mail ${JSON.stringify(receiptMail)}`);
    return NextResponse.json({ success: true, ...result, saleSweep, income, expense, programStock, inventoryEvents, workflowEvents, receivingApply, receipt, receiptStuck, receiptPush, donorSync, receiptMail });
});
