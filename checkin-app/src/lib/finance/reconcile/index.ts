import crypto from "crypto";
import prisma from "@/lib/prisma";
import type { DbClient, TxClient } from "@/lib/db-client";
import { logger } from "@/lib/logger";
import * as mirror from "@/lib/shopifyRead/client";
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

/**
 * How far behind the mirror's clock the cursor stays. A sync stamps a row moments before
 * its transaction commits, so a row stamped later than this may not be visible yet.
 */
const CURSOR_HOLD_BACK_MS = 5 * 60_000;

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
async function releaseReconcileLease(token: string, advanceTo: mirror.MirrorCursor | null): Promise<void> {
    const { count } = await prisma.boardSettings.updateMany({
        where: { id: 1, shopifyReconcileLeaseToken: token },
        data: {
            shopifyReconcileLeaseUntil: null,
            shopifyReconcileLeaseToken: null,
            ...(advanceTo ? { shopifyReconcileCursorAt: advanceTo.syncedAt, shopifyReconcileCursorGid: advanceTo.orderGid } : {}),
        },
    });
    if (count !== 1) logger.error("[reconcile] the lease expired before the pass finished; the cursor was not advanced");
}

/**
 * One reconciliation pass. No-op (configured:false) when the mirror isn't wired, and
 * `leaseHeld` when another pass is running. `recordStart` commits with the lease claim. Advances the
 * BoardSettings cursor past the orders it processed so the next run reads only orders synced since.
 */
export async function runReconcile(recordStart?: RecordStart): Promise<ReconcileResult> {
    if (!mirror.isConfigured()) return { configured: false, ordersScanned: 0, reversalsRaised: 0, failed: 0 };

    const token = await takeReconcileLease(recordStart);
    if (!token) return { configured: true, ordersScanned: 0, reversalsRaised: 0, failed: 0, leaseHeld: true };

    let advanceTo: mirror.MirrorCursor | null = null;
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
async function reconcilePass(): Promise<{ result: ReconcileResult; advanceTo: mirror.MirrorCursor | null }> {
    const settings = await prisma.boardSettings.findUnique({
        where: { id: 1 },
        select: { shopifyReconcileCursorAt: true, shopifyReconcileCursorGid: true },
    });
    const cursor = settings?.shopifyReconcileCursorAt
        ? { syncedAt: settings.shopifyReconcileCursorAt, orderGid: settings.shopifyReconcileCursorGid ?? "" }
        : null;

    const now = await mirror.mirrorNow();
    const settledBy = now ? new Date(now.getTime() - CURSOR_HOLD_BACK_MS) : null;
    const orders = await mirror.ordersSyncedAfter(cursor);
    let advanceTo: mirror.MirrorCursor | null = null;
    // The cursor stops before the first order whose pass throws, so the next run
    // retries it. Later orders are still processed; re-reading them is harmless.
    let cursorFrozen = false;
    let failed = 0;
    for (const order of orders) {
        try {
            // Both passes run: a mixed cart pays for a membership AND program seats.
            await reconcileForwardMembership(order);
            await reconcileForwardProgram(order);
        } catch (e) {
            logger.error(`[reconcile] forward pass failed for order ${order.legacyId ?? order.orderGid}:`, e);
            failed++;
            cursorFrozen = true;
        }
        if (!cursorFrozen && settledBy && order.lastSyncedAt <= settledBy) {
            advanceTo = { syncedAt: order.lastSyncedAt, orderGid: order.orderGid };
        }
    }

    // A throw here leaves the cursor where it was, so the next run re-scans.
    const reversalsRaised = await reconcileReversals();

    return {
        result: { configured: true, ordersScanned: orders.length, reversalsRaised, failed },
        advanceTo,
    };
}
