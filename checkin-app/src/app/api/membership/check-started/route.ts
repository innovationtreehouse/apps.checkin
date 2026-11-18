import { handler, ApiResponseError, badRequest, unauthorized } from "@/security/handler";
import { EXTERNAL_ERROR_STATUS } from "@/lib/domainErrorResponse";
import { ExternalError } from "@/lib/membership/external";
import { checkStartedRows, markCheckStarted } from "@/lib/membership/checkStarted";

export const dynamic = "force-dynamic";

/**
 * GET /api/membership/check-started — the rows the caller may mark as having
 * started a background check: their own, and for a household lead each other
 * adult of their household. Each row carries only personId, name and state.
 */
export const GET = handler("GET /api/membership/check-started", async ({ auth }) => {
    if (auth.type !== "session") throw unauthorized();
    return { CheckStartedRow: await checkStartedRows(auth.user.id) };
});

/**
 * POST /api/membership/check-started — marks one person's check started.
 * Body: { personId }. markCheckStarted decides whom the caller may mark. Returns
 * the refreshed rows.
 */
export const POST = handler("POST /api/membership/check-started", async ({ req, auth }) => {
    if (auth.type !== "session") throw unauthorized();
    let body: { personId?: unknown };
    try {
        body = await req.json();
    } catch {
        throw badRequest("Invalid JSON");
    }
    const personId = Number(body.personId);
    if (!Number.isInteger(personId) || personId <= 0) throw badRequest("personId is required");
    try {
        await markCheckStarted(personId, auth.user.id);
    } catch (e) {
        if (e instanceof ExternalError) throw new ApiResponseError(EXTERNAL_ERROR_STATUS[e.code], e.message);
        throw e;
    }
    return { CheckStartedRow: await checkStartedRows(auth.user.id) };
});
