import { handler, ApiResponseError, badRequest, forbidden, notFound, unauthorized } from "@/security/handler";
import { ReviewError } from "@/lib/membership/review";
import { recordRefund } from "@/lib/membership/refund";

export const dynamic = "force-dynamic";

/**
 * POST /api/membership-ops/applications/refund — board records a membership refund
 * already made in Shopify. Body: { processId, reason }. A paid application waiting on
 * its background check returns to PENDING_PAYMENT; a paid BLOCKED one stays BLOCKED.
 * Responds with the application's id and new status only.
 */
export const POST = handler("POST /api/membership-ops/applications/refund", async ({ req, auth }) => {
    if (auth.type !== "session") throw unauthorized();

    let body: { processId?: number; reason?: string };
    try {
        body = await req.json();
    } catch {
        throw badRequest("Invalid JSON");
    }
    const reason = body.reason?.trim();
    if (!body.processId || !reason) throw badRequest("processId and reason are required");

    try {
        const { status } = await recordRefund(body.processId, auth.user.id, reason);
        return { OrgMembershipProcess: { id: body.processId, status } };
    } catch (error) {
        if (error instanceof ReviewError) {
            if (error.code === "not_found") throw notFound(error.message);
            if (error.code === "same_household_applicant") throw forbidden(error.message);
            throw new ApiResponseError(409, error.message);
        }
        throw error;
    }
});
