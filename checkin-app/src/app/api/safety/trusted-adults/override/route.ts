import { NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import { withAuth } from "@/lib/auth";
import { resetReview, revokeReview, TrustedAdultError } from "@/lib/trusted-adult/service";
import { apiError } from "@/lib/api-response";
import { trustedAdultErrorResponse } from "@/lib/domainErrorResponse";

export const dynamic = "force-dynamic";

/**
 * POST /api/safety/trusted-adults/override — board/isSysadmin reset a decided review
 * back to board review, or revoke the adult. Body: { reviewId, action: reset|revoke, reason }.
 */
export const POST = withAuth({ roles: ["isBoardMember", "isSysadmin"] }, async (req, auth) => {
    if (auth.type !== "session") return apiError("Unauthorized", 401);
    let body: { reviewId?: number; action?: "reset" | "revoke"; reason?: string };
    try {
        body = await req.json();
    } catch {
        return apiError("Invalid JSON", 400);
    }
    if (!body.reviewId || !["reset", "revoke"].includes(body.action ?? "")) {
        return apiError("reviewId and action (reset|revoke) are required", 400);
    }
    try {
        const outcome = body.action === "reset"
            ? await resetReview(body.reviewId, auth.user.id, body.reason ?? "")
            : await revokeReview(body.reviewId, auth.user.id);
        return NextResponse.json({ status: outcome.status });
    } catch (error) {
        if (error instanceof TrustedAdultError) {
            return trustedAdultErrorResponse(error);
        }
        logger.error("Trusted adult override error:", error);
        return apiError("Internal Server Error", 500);
    }
});
