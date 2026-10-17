import { NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import { withCron } from "@/lib/cronAuth";
import { runLifecycleReconcile } from "@/lib/lifecycleDrift";

/**
 * Invariant-driven lifecycle reconciler. Scans BOTH
 * lifecycle models with the machines' OWN `validate()` oracles, auto-heals the one
 * safe unambiguous case — enrollment I1 (`status=ACTIVE` with a stranded
 * `inventoryHeldAt`: a Shopify `-1` the webhook took but died before releasing) by
 * clearing the hold and firing the missed `+1` — and reports every other
 * off-diagram row to the sysadmin/board channel for a human to resolve. Nothing
 * ambiguous is auto-mutated.
 *
 * Complementary to `cron/reconcile-shopify` (order-driven recovery): this is the
 * invariant-driven backstop for the dual-write crash window that the order path
 * can't see. Same `withCron` auth as the other crons.
 */
export const GET = withCron(async () => {
    const result = await runLifecycleReconcile();
    logger.info(`[lifecycle-reconcile] ${JSON.stringify(result)}`);
    return NextResponse.json({ success: true, ...result });
});
