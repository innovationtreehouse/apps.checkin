import { NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import { withAuth } from "@/lib/auth";
import { boardResetReview, ReviewError } from "@/lib/membership/review";
import { releaseDepartedRejection } from "@/lib/membership/settleHouseholdBg";
import { apiError } from "@/lib/api-response";
import { reviewErrorResponse } from "@/lib/domainErrorResponse";

export const dynamic = "force-dynamic";

/**
 * POST /api/membership-ops/applications/review-override — board reset of a
 * background-check review. Body: { processId, action: 'reset', reason, wrongPerson? }.
 * Clears the attestations and sends the review back for two new approvals
 * (re-pings reviewers). Reaches a BLOCKED review and one still in progress; a
 * cleared one is out of reach. `wrongPerson` also clears the person a household's
 * review named. The board cannot clear a check.
 *
 * Body { processId, action: 'release', reason } releases a household application
 * from the rejection of someone who has left the household; the rejection stays on
 * that person.
 */
export const POST = withAuth({ roles: ["isBoardMember"] }, async (req, auth) => {
    if (auth.type !== "session") return apiError("Unauthorized", 401);
    let body: { processId?: number; action?: string; reason?: unknown; wrongPerson?: unknown };
    try {
        body = await req.json();
    } catch {
        return apiError("Invalid JSON", 400);
    }
    if (typeof body.processId !== "number" || (body.action !== "reset" && body.action !== "release")) {
        return apiError("processId and action 'reset' or 'release' are required", 400);
    }
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    if (!reason) return apiError("A reason is required", 400);
    try {
        const outcome = body.action === "release"
            ? await releaseDepartedRejection(body.processId, auth.user.id, reason)
            : await boardResetReview(body.processId, auth.user.id, { reason, wrongPerson: body.wrongPerson === true });
        return NextResponse.json({ outcome });
    } catch (error) {
        if (error instanceof ReviewError) {
            return reviewErrorResponse(error);
        }
        logger.error("Review override error:", error);
        return apiError("Internal Server Error", 500);
    }
});
