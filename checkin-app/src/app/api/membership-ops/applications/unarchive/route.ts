import { NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import { withAuth } from "@/lib/auth";
import { ReviewError } from "@/lib/membership/review";
import { unarchiveApplication } from "@/lib/membership/archive";
import { apiError } from "@/lib/api-response";
import { reviewErrorResponse } from "@/lib/domainErrorResponse";

export const dynamic = "force-dynamic";

/**
 * POST /api/membership-ops/applications/unarchive — board "Reopen" of a closed
 * application. Body: { processId }. Returns it to the step it was closed from;
 * 409 with the reason when the household is DENIED or already has another open
 * application; 403 on the actor's own household.
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
        const outcome = await unarchiveApplication(body.processId, auth.user.id);
        return NextResponse.json({ outcome });
    } catch (error) {
        if (error instanceof ReviewError) {
            return reviewErrorResponse(error);
        }
        logger.error("Reopen application error:", error);
        return apiError("Internal Server Error", 500);
    }
});
