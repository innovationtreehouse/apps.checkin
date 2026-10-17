import { NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import { withAuth } from "@/lib/auth";
import { apiError } from "@/lib/api-response";
import { scanLifecycleViolations } from "@/lib/lifecycleDrift";

/**
 * System Status "Lifecycle" data source: the current
 * off-diagram row set across both lifecycle models, computed live from the same
 * `validate()` the reconciler cron uses — so the board sees drift without waiting
 * for the cron email. Read-only; no predicate is re-derived here.
 */
export const GET = withAuth(
    { roles: ["isSysadmin", "isBoardMember"] },
    async () => {
        try {
            const { violations, scanned } = await scanLifecycleViolations();
            return NextResponse.json({ violations, scanned });
        } catch (error) {
            logger.error("Failed to scan lifecycle violations:", error);
            return apiError("Internal Server Error", 500);
        }
    },
);
