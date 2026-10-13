import { NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import { withAuth } from "@/lib/auth";
import { ReviewError } from "@/lib/membership/review";
import { archiveApplication } from "@/lib/membership/archive";
import { apiError } from "@/lib/api-response";

export const dynamic = "force-dynamic";

/**
 * POST /api/membership-ops/applications/archive — board "Close application" for a
 * long-idle, unpaid application. Body: { processId }. Idempotent. 409 when it is
 * paid, BLOCKED, PENDING_BG_CLEARANCE or ACTIVE; 403 on the actor's own household.
 */
export const POST = withAuth({ roles: ["isSysadmin", "isBoardMember"] }, async (req, auth) => {
    if (auth.type !== "session") return apiError("Unauthorized", 401);
    let body: { processId?: number };
    try {
        body = await req.json();
    } catch {
        return apiError("Invalid JSON", 400);
    }
    if (!body.processId) return apiError("processId is required", 400);
    try {
        const outcome = await archiveApplication(body.processId, auth.user.id);
        return NextResponse.json({ outcome });
    } catch (error) {
        if (error instanceof ReviewError) {
            return NextResponse.json({ error: error.message, code: error.code }, { status: error.code === "not_found" ? 404 : error.code === "same_household_applicant" ? 403 : 409 });
        }
        logger.error("Close application error:", error);
        return apiError("Internal Server Error", 500);
    }
});
