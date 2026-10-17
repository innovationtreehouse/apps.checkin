import { NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import { withAuth } from "@/lib/auth";
import { overrideBlocked, subjectIds, ReviewError } from "@/lib/membership/review";
import { apiError } from "@/lib/api-response";

export const dynamic = "force-dynamic";

/**
 * POST /api/membership-ops/applications/review-override — board action on an
 * application's background-check review.
 * Body: { processId, action: 'reset' | 'approve', subjectPersonIds }
 *   reset   — clear attestations, send back for re-review (re-ping reviewers).
 *             Reaches a BLOCKED review and one still in progress (undoing an
 *             accidental approval); a cleared one is out of reach.
 *   approve — board override on a BLOCKED review: clear the check, activating if
 *             already paid else leaving it at PENDING_PAYMENT. A household override
 *             must name the adults it covers (subjectPersonIds) — the board asserts
 *             them, since a blocked process has no second approval to count.
 */
export const POST = withAuth({ roles: ["isSysadmin", "isBoardMember"] }, async (req, auth) => {
    if (auth.type !== "session") return apiError("Unauthorized", 401);
    let body: { processId?: number; action?: "reset" | "approve"; subjectPersonIds?: number[] };
    try {
        body = await req.json();
    } catch {
        return apiError("Invalid JSON", 400);
    }
    if (!body.processId || (body.action !== "reset" && body.action !== "approve")) {
        return apiError("processId and action (reset|approve) are required", 400);
    }
    try {
        const outcome = await overrideBlocked(body.processId, auth.user.id, body.action, subjectIds(body.subjectPersonIds));
        return NextResponse.json({ outcome });
    } catch (error) {
        if (error instanceof ReviewError) {
            const status = error.code === "not_found" ? 404 : error.code === "same_household_applicant" ? 403 : error.code === "invalid_subject" ? 400 : 409;
            return NextResponse.json({ error: error.message, code: error.code }, { status });
        }
        logger.error("Review override error:", error);
        return apiError("Internal Server Error", 500);
    }
});
