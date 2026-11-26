import crypto from "crypto";
import prisma from "@/lib/prisma";
import type { DbClient, TxClient } from "@/lib/db-client";
import { logger } from "@/lib/logger";
import * as mirror from "@/lib/shopifyRead/client";
import { raisePaymentException } from "./exceptions";
import { reconcileForwardMembership } from "./membership";
import { reconcileForwardProgram } from "./program";
import { reconcileReversals } from "./reversals";

/**
 * Shopify payment reconciler. Reads the s-read `shopify_read` mirror and aligns
 * Shopify order truth with membership/program truth, both directions:
 *
 *   forward  — a paid order whose family is still stuck at PENDING_PAYMENT is a
 *              MISSED orders/paid webhook: recover it (activate), advancing the
 *              family past the paid checkpoint. Application AND renewal.
 *   reversal — an order we already activated on that is later refunded, charged
 *              back, or cancelled: raise a PaymentException for the board. We never
 *              auto-revert access (a chargeback can be a bank error); only the
 *              board removes a paid place.
 *
 * Runs once daily from api/cron/reconcile-shopify (09:15 UTC, just behind s-read's
 * 09:00 sync — the cadence is a scale-to-zero constraint, see that route), and from
 * the payments page after its "Sync now" read completes, or when the board retries a
 * check the daily pass blocked. A lease on BoardSettings
 * lets one pass run at a time; a pass that finds it held does nothing.
 * Idempotent: forward recovery is a no-op once activate() has recorded the order
 * (activate stores shopifyOrderId and short-circuits on paidAt), and every
 * exception upserts on (kind, order, person).
 *
 * Matching uses the SAME cart attribute the webhook credits — Membership_Process_ID
 * (or CheckMeIn_Account_ID + Program_ID), mirrored on the order — so attribution is
 * exact. Orders synced before the mirror carried attributes have none and fall back to customer
 * email → household lead → the family's single pending process.
 *
 * Membership recovery replicates the webhook's variant-id check that the order
 * really contains the membership product: the mirror's order lines carry variant
 * ids, so recovery gates on the order containing one of checkin's known
 * membership variants — the exact set the webhook builds — never on order total.
 * Nothing is guessed: an attribute naming an unknown process, an ambiguous email
 * match, or an order with no membership item raises a problem for the board rather
 * than activating. One policy check rides on top of the variant gate: a
 * non-volunteer family redeeming the board's volunteer discount code raises
 * DISCOUNT_UNAUTHORIZED instead of activating (see usesVolunteerCodeUnentitled).
 *
 * The program side carries the parallel check, judged AT THE MONEY EVENT: a minted
 * `PRG{programId}-H{householdId}-XXXXXXXX` member-discount code redeemed on another
 * household's order, or by a household that isn't fee-settled through the program's
 * coverage date, raises the same DISCOUNT_UNAUTHORIZED instead of activating. The
 * orders/paid webhook asks it for a live checkout; this forward pass asks it when
 * recovering a missed webhook. The reversal pass deliberately does NOT re-ask it:
 * entitlement is a fact about the moment money moved, so a household deactivated
 * later never retro-flags orders that were honest when they were paid (see
 * unentitledMemberCodeUse).
 */

export interface ReconcileResult {
    configured: boolean;
    ordersScanned: number;
    reversalsRaised: number;
    /** Orders whose forward pass threw. The cron route surfaces it as the run's
     *  health signal (lib/cronAuth.ts) — isolating a bad order keeps the sweep
     *  going and the run still counts as having RUN, but it is not clean. Do not
     *  reuse this key for anything else: withCron reads `failed` by name. */
    failed: number;
    /** Another pass held the lease, so this one scanned nothing. */
    leaseHeld?: true;
}

/** How long one pass may hold the lease; a pass that crashed frees it when this runs out. */
const RECONCILE_LEASE_MS = 15 * 60_000;

/** CHECK_FAILED rows within the window, resolved ones included, at which the check counts as broken and stops. */
const CHECK_FAILED_LIMIT = 3;
const CHECK_FAILED_WINDOW_MS = 7 * 24 * 60 * 60_000;

/** The error's class and code only, since a message can carry customer data. */
function errorSummary(e: unknown): string {
    if (!(e instanceof Error)) return "Unknown error";
    const code = "code" in e && typeof e.code === "string" ? ` ${e.code}` : "";
    return `${e.name}${code}`.slice(0, 120);
}

/** Writes made with the lease claim, such as the audit row of the run it starts. */
export type RecordStart = (tx: TxClient) => Promise<unknown>;

/**
 * Take the reconcile lease if it is free or expired. `recordStart` commits with the
 * claim, so a pass that never got the lease records nothing. No transaction stays open
 * during the pass.
 */
async function takeReconcileLease(recordStart?: RecordStart): Promise<string | null> {
    const token = crypto.randomUUID();
    const now = new Date();
    const claim = async (db: DbClient) => {
        const { count } = await db.boardSettings.updateMany({
            where: { id: 1, OR: [{ shopifyReconcileLeaseUntil: null }, { shopifyReconcileLeaseUntil: { lt: now } }] },
            data: { shopifyReconcileLeaseUntil: new Date(now.getTime() + RECONCILE_LEASE_MS), shopifyReconcileLeaseToken: token },
        });
        return count === 1;
    };
    if (!recordStart) return (await claim(prisma)) ? token : null;
    return prisma.$transaction(async (tx) => {
        if (!(await claim(tx))) return null;
        await recordStart(tx);
        return token;
    });
}

/**
 * Free the lease, writing the new cursor in the same statement so only the lease
 * holder ever moves it. A pass whose lease expired and was taken writes nothing.
 */
async function releaseReconcileLease(token: string, advanceTo: Date | null): Promise<void> {
    const { count } = await prisma.boardSettings.updateMany({
        where: { id: 1, shopifyReconcileLeaseToken: token },
        data: {
            shopifyReconcileLeaseUntil: null,
            shopifyReconcileLeaseToken: null,
            ...(advanceTo ? { shopifyReconcileCursorAt: advanceTo } : {}),
        },
    });
    if (count !== 1) logger.error("[reconcile] the lease expired before the pass finished; the cursor was not advanced");
}

/**
 * One reconciliation pass. No-op (configured:false) when the mirror isn't wired, and
 * `leaseHeld` when another pass is running. `recordStart` commits with the lease claim. Advances BoardSettings.shopifyReconcileCursorAt
 * to the newest order it processed so the next run only re-scans changed orders.
 */
export async function runReconcile(recordStart?: RecordStart): Promise<ReconcileResult> {
    if (!mirror.isConfigured()) return { configured: false, ordersScanned: 0, reversalsRaised: 0, failed: 0 };

    const token = await takeReconcileLease(recordStart);
    if (!token) return { configured: true, ordersScanned: 0, reversalsRaised: 0, failed: 0, leaseHeld: true };

    let advanceTo: Date | null = null;
    try {
        const pass = await reconcilePass();
        advanceTo = pass.advanceTo;
        return pass.result;
    } finally {
        // A failed release must not turn a finished pass into a failure; the lease frees itself when it expires.
        await releaseReconcileLease(token, advanceTo).catch((e: unknown) => {
            logger.error("[reconcile] failed to free the lease; it frees itself when it expires:", e);
        });
    }
}

/** The pass itself, under the lease. `advanceTo` is the cursor to write, or null to leave it. */
async function reconcilePass(): Promise<{ result: ReconcileResult; advanceTo: Date | null }> {
    const settings = await prisma.boardSettings.findUnique({ where: { id: 1 }, select: { shopifyReconcileCursorAt: true } });
    const cursor = settings?.shopifyReconcileCursorAt ?? null;

    const orders = await mirror.ordersChangedSince(cursor);
    let newCursor = cursor;
    // An order whose pass throws becomes a CHECK_FAILED exception and the cursor moves
    // past it. At CHECK_FAILED_LIMIT the check is broken: it stops before that order,
    // raises one CHECK_STOPPED exception keyed on that order, and every later run stops
    // there until it is fixed.
    let stopped = false;
    let failed = 0;
    let recentFailures: number | null = null;
    for (const order of orders) {
        const orderId = order.legacyId ?? order.orderGid;
        try {
            // Both passes run: a mixed cart pays for a membership AND program seats.
            await reconcileForwardMembership(order);
            await reconcileForwardProgram(order);
        } catch (e) {
            logger.error(`[reconcile] forward pass failed for order ${orderId}:`, e);
            failed++;
            recentFailures ??= await prisma.paymentException.count({
                where: { kind: "CHECK_FAILED", detectedAt: { gte: new Date(Date.now() - CHECK_FAILED_WINDOW_MS) } },
            });
            if (recentFailures + failed < CHECK_FAILED_LIMIT) {
                await raisePaymentException("CHECK_FAILED", { shopifyOrderId: orderId, evidence: errorSummary(e) });
            } else {
                await raisePaymentException("CHECK_STOPPED", { shopifyOrderId: orderId, evidence: errorSummary(e) });
                stopped = true;
                // ordersChangedSince compares with a strict `updated_at >`, and an earlier order
                // with the same timestamp may already have moved the cursor there: pull it back
                // below this order so the next run reads it again.
                if (order.updatedAt && newCursor && newCursor >= order.updatedAt) {
                    newCursor = new Date(order.updatedAt.getTime() - 1);
                }
                break;
            }
        }
        if (order.updatedAt && (!newCursor || order.updatedAt > newCursor)) newCursor = order.updatedAt;
    }

    // A throw here leaves the cursor where it was, so the next run re-scans.
    const reversalsRaised = stopped ? 0 : await reconcileReversals();

    return {
        result: { configured: true, ordersScanned: orders.length, reversalsRaised, failed },
        advanceTo: newCursor && newCursor !== cursor ? newCursor : null,
    };
}
