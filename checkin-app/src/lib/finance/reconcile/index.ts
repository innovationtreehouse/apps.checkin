import crypto from "crypto";
import prisma from "@/lib/prisma";
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
 * the payments page after its "Sync now" read completes. A lease on BoardSettings
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

/** Take the reconcile lease if it is free or expired. One short statement; no transaction stays open. */
async function takeReconcileLease(): Promise<string | null> {
    const token = crypto.randomUUID();
    const now = new Date();
    const { count } = await prisma.boardSettings.updateMany({
        where: { id: 1, OR: [{ shopifyReconcileLeaseUntil: null }, { shopifyReconcileLeaseUntil: { lt: now } }] },
        data: { shopifyReconcileLeaseUntil: new Date(now.getTime() + RECONCILE_LEASE_MS), shopifyReconcileLeaseToken: token },
    });
    return count === 1 ? token : null;
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
 * `leaseHeld` when another pass is running. Advances BoardSettings.shopifyReconcileCursorAt
 * to the newest order it processed so the next run only re-scans changed orders.
 */
export async function runReconcile(): Promise<ReconcileResult> {
    if (!mirror.isConfigured()) return { configured: false, ordersScanned: 0, reversalsRaised: 0, failed: 0 };

    const token = await takeReconcileLease();
    if (!token) return { configured: true, ordersScanned: 0, reversalsRaised: 0, failed: 0, leaseHeld: true };

    let advanceTo: Date | null = null;
    try {
        const pass = await reconcilePass();
        advanceTo = pass.advanceTo;
        return pass.result;
    } finally {
        await releaseReconcileLease(token, advanceTo);
    }
}

/** The pass itself, under the lease. `advanceTo` is the cursor to write, or null to leave it. */
async function reconcilePass(): Promise<{ result: ReconcileResult; advanceTo: Date | null }> {
    const settings = await prisma.boardSettings.findUnique({ where: { id: 1 }, select: { shopifyReconcileCursorAt: true } });
    const cursor = settings?.shopifyReconcileCursorAt ?? null;

    const orders = await mirror.ordersChangedSince(cursor);
    let newCursor = cursor;
    // Stop advancing the cursor at the first order whose pass throws: advancing past
    // it would skip that order FOREVER (the forward pass is cursor-once). Later
    // orders in this batch still get processed (idempotent, so re-scanning them
    // tomorrow is harmless); only the watermark holds back until the bad order heals.
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
            // The watermark may ALREADY sit at this order's updatedAt — an earlier
            // order in the batch with the same timestamp succeeded and advanced it.
            // ordersChangedSince compares with a strict `updated_at >`, so leaving
            // the cursor there would skip this order forever. Pull it back below
            // the failed order so the next run re-fetches it.
            if (order.updatedAt && newCursor && newCursor >= order.updatedAt) {
                newCursor = new Date(order.updatedAt.getTime() - 1);
            }
        }
        if (!cursorFrozen && order.updatedAt && (!newCursor || order.updatedAt > newCursor)) newCursor = order.updatedAt;
    }

    // A throw here leaves the cursor where it was, so the next run re-scans.
    const reversalsRaised = await reconcileReversals();

    return {
        result: { configured: true, ordersScanned: orders.length, reversalsRaised, failed },
        advanceTo: newCursor && newCursor !== cursor ? newCursor : null,
    };
}
