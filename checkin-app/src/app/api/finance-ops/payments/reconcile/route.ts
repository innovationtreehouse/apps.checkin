import { logger } from "@/lib/logger";
import { ApiResponseError, handler } from "@/security/handler";
import { personActor } from "@/lib/auditActor";
import { runReconcile, type ReconcileResult } from "@/lib/finance/reconcile";
import { isConfigured } from "@/lib/shopifyRead/client";

/**
 * POST /api/finance-ops/payments/reconcile — the board re-runs the Shopify payment
 * check after "Sync now" refreshes the mirror, so the problem list matches the live
 * amounts beside it. The page's "Run the payment check" retries one the daily run's
 * lease blocked.
 *
 * Runs only the reconcile (lib/finance/reconcile), never the daily cron's other steps
 * such as the receipt mail run. The reconcile also recovers missed orders/paid
 * webhooks, exactly as the daily run does; it is idempotent. Its lease keeps it from
 * overlapping the daily run: when that holds it, this answers 409.
 *
 * Audited as a SHOPIFY_RECONCILE row with no entity (affectedEntityId 0), committed with
 * the lease claim, so a run that gets the lease is always on record and a 409 writes
 * nothing. The body is never read.
 */
export const POST = handler(
    "POST /api/finance-ops/payments/reconcile",
    async ({ auth }) => {
        if (auth.type !== "session") throw new ApiResponseError(401, "Unauthorized");
        if (!isConfigured()) {
            throw new ApiResponseError(503, "The Shopify mirror is not wired in this environment");
        }

        let result: ReconcileResult;
        try {
            result = await runReconcile((tx) => tx.auditLog.create({
                data: {
                    ...personActor(auth.user.id),
                    action: "CREATE",
                    tableName: "SHOPIFY_RECONCILE",
                    affectedEntityId: 0,
                    newData: { trigger: "payments page" },
                },
            }));
        } catch (error) {
            logger.error("Failed to run the Shopify payment check:", error);
            throw new ApiResponseError(500, "Failed to refresh the payment problems");
        }

        if (result.leaseHeld) {
            throw new ApiResponseError(409, "The daily payment check is running now");
        }
        logger.info(`[reconcile] payment check run from the payments page by user ${auth.user.id}`);
        const { configured, ordersScanned, reversalsRaised, failed } = result;
        return { PaymentReconcileRun: { configured, ordersScanned, reversalsRaised, failed } };
    },
);
