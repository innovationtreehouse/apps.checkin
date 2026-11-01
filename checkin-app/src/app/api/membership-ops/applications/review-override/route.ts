import { NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import { withAuth } from "@/lib/auth";
import { boardResetReview, ReviewError } from "@/lib/membership/review";
import { apiError } from "@/lib/api-response";
import { reviewErrorResponse } from "@/lib/domainErrorResponse";

export const dynamic = "force-dynamic";

/**
 * POST /api/membership-ops/applications/review-override — board reset of an
 * application's background-check review. Body: { processId, action: 'reset' }.
 * Clears the attestations and sends the review back for two new approvals
 * (re-pings reviewers). Reaches a BLOCKED review and one still in progress; a
 * cleared one is out of reach. The board cannot clear a check.
 */
export const POST = withAuth({ roles: ["isBoardMember"] }, async (req, auth) => {
    if (auth.type !== "session") return apiError("Unauthorized", 401);
    let body: { processId?: number; action?: string };
    try {
        body = await req.json();
    } catch {
        return apiError("Invalid JSON", 400);
    }
    if (!body.processId || body.action !== "reset") {
        return apiError("processId and action 'reset' are required", 400);
    }
    try {
        const outcome = await boardResetReview(body.processId, auth.user.id);
        return NextResponse.json({ outcome });
    } catch (error) {
        if (error instanceof ReviewError) {
            return reviewErrorResponse(error);
        }
        logger.error("Review override error:", error);
        return apiError("Internal Server Error", 500);
    }
});
