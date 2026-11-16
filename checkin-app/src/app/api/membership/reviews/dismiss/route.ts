import { handler, ApiResponseError, badRequest, unauthorized } from "@/security/handler";
import { REVIEW_ERROR_STATUS } from "@/lib/domainErrorResponse";
import { dismissCheckStarted, ReviewError } from "@/lib/membership/review";

export const dynamic = "force-dynamic";

/**
 * POST /api/membership/reviews/dismiss — a reviewer or Board member dismisses a
 * check review opened by mistake. Body: { processId, reason } (reason mandatory).
 * dismissCheckStarted() enforces that no decision or rejection is on the review
 * and the household bar.
 */
export const POST = handler("POST /api/membership/reviews/dismiss", async ({ req, auth }) => {
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
        await dismissCheckStarted(processId, auth.user.id, reason);
    } catch (e) {
        if (e instanceof ReviewError) throw new ApiResponseError(REVIEW_ERROR_STATUS[e.code], e.message);
        throw e;
    }
    return {};
});
