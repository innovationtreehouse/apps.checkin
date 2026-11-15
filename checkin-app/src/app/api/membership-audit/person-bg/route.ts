import { NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import { withAuth } from "@/lib/auth";
import { apiError } from "@/lib/api-response";
import { submitPersonBgForReview } from "@/lib/membership/personBgSubmit";
import { ExternalError } from "@/lib/membership/external";
import { externalErrorResponse } from "@/lib/domainErrorResponse";

export const dynamic = "force-dynamic";

/**
 * POST /api/membership-audit/person-bg — board/sysadmin marks a person's
 * background check started, putting their check review in the reviewers' queue
 * for two-reviewer approval. Body: { personId }. Idempotent. The subject may have
 * no login.
 */
export const POST = withAuth({ roles: ["isSysadmin", "isBoardMember"] }, async (req, auth) => {
    if (auth.type !== "session") return apiError("Unauthorized", 401);
    let body: { personId?: number };
    try {
        body = await req.json();
    } catch {
        return apiError("Invalid JSON", 400);
    }
    if (!body.personId) return apiError("personId is required", 400);
    try {
        const { processId } = await submitPersonBgForReview(body.personId, auth.user.id);
        return NextResponse.json({ process: { id: processId } });
    } catch (error) {
        if (error instanceof ExternalError) return externalErrorResponse(error);
        logger.error("submitPersonBgForReview error:", error);
        return apiError("Internal Server Error", 500);
    }
});
