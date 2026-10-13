import { NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import { withCron } from "@/lib/cronAuth";
import { runReconcile } from "@/lib/finance/reconcile";
import { runSaleSweep } from "@/lib/programs/saleSweep";

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
 * lib/finance/reconcile.ts. No-op when the mirror isn't wired
 * (config.shopifyReadDatabaseUrl() null — no SHOPIFY_READ_DB / override set).
 *
 * Also runs the program-sale sweep (lib/programs/saleSweep.ts): ends sales whose
 * off-sale date has arrived and emails the board unpaid claims a week later.
 */
export const GET = withCron(async () => {
    const result = await runReconcile();
    logger.info(`[reconcile] ${JSON.stringify(result)}`);
    const saleSweep = await runSaleSweep();
    logger.info(`[sale-sweep] ${JSON.stringify(saleSweep)}`);
    return NextResponse.json({ success: true, ...result, saleSweep });
});
