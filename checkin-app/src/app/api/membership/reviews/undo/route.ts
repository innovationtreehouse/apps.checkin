import { handler, ApiResponseError, badRequest, unauthorized } from "@/security/handler";
import { REVIEW_ERROR_STATUS } from "@/lib/domainErrorResponse";
import { undoOwnApproval, ReviewError } from "@/lib/membership/review";

export const dynamic = "force-dynamic";

/**
 * POST /api/membership/reviews/undo — a reviewer withdraws their own approval
 * while the review still waits on its second reviewer. Body: { processId, reason }
 * (reason mandatory). undoOwnApproval() enforces ownership, APPROVE-only, not
 * cleared, and still in review.
 */
export const POST = handler("POST /api/membership/reviews/undo", async ({ req, auth }) => {
    if (auth.type !== "session") throw unauthorized();
    let body: { processId?: unknown; reason?: unknown };
    try {
        body = await req.json();
    } catch {
        throw badRequest("Invalid JSON");
    }
    const processId = Number(body.processId);
    if (!Number.isInteger(processId) || processId <= 0) throw badRequest("processId is required");
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    if (!reason) throw badRequest("A reason is required");
    try {
        await undoOwnApproval(auth.user.id, processId, reason);
    } catch (e) {
        if (e instanceof ReviewError) throw new ApiResponseError(REVIEW_ERROR_STATUS[e.code], e.message);
        throw e;
    }
    return {};
});
