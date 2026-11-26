import { logger } from "@/lib/logger";
import { ApiResponseError, handler } from "@/security/handler";
import { isConfigured, syncStatus } from "@/lib/shopifyRead/client";

/**
 * GET /api/finance-ops/s-read/sync/status — the latest finished daily read, a daily read
 * still running after it, and the latest repair that finished after it, for the payments
 * page's last-sync line.
 * A repair never stands in for the daily read, so a failing daily read stays visible.
 * Unwired mirror → 503, so the page hides the line.
 */
export const GET = handler(
    "GET /api/finance-ops/s-read/sync/status",
    async () => {
        if (!isConfigured()) {
            throw new ApiResponseError(503, "The Shopify mirror is not wired in this environment");
        }

        try {
            return { SReadSyncStatus: (await syncStatus()) ?? { scheduled: null, running: null, laterRepair: null } };
        } catch (error) {
            logger.error("Failed to read the s-read sync status:", error);
            throw new ApiResponseError(500, "Failed to read the Shopify sync status");
        }
    },
);
