import { handler, ApiResponseError, badRequest, unauthorized } from "@/security/handler";
import { openPersonAgreementForBoard, PersonAgreementError } from "@/lib/membership/personAgreementTriggers";

export const dynamic = "force-dynamic";

/**
 * POST /api/membership-audit/person-agreement — board/sysadmin opens an individual
 * membership agreement for one adult who isn't a household lead, for the membership year
 * the Board picks. Body: { personId, year }.
 *
 * Reaches anyone the automatic rule doesn't: an unknown age, any relationship, no program.
 * Refuses a household lead — they sign the household agreement, and an open
 * PERSON_AGREEMENT on a lead would shadow it — and a date of birth showing a minor.
 * Idempotent: an obligation already open is returned as-is.
 *
 * Responds with the obligation's id/kind/status only. Nothing identifying the subject
 * goes back out: the caller already named them.
 */
export const POST = handler("POST /api/membership-audit/person-agreement", async ({ req, auth }) => {
    if (auth.type !== "session") throw unauthorized();

    let body: { personId?: number; year?: unknown };
    try {
        body = await req.json();
    } catch {
        throw badRequest("Invalid JSON");
    }
    if (!body.personId) throw badRequest("personId is required");
    const year = body.year;
    if (typeof year !== "number" || !Number.isInteger(year)) throw badRequest("Choose the membership year this agreement is for.");

    try {
        const process = await openPersonAgreementForBoard(body.personId, auth.user.id, year);
        return { OrgMembershipProcess: { id: process.id, kind: process.kind, status: process.status } };
    } catch (error) {
        // A refusal the board needs to read (lead / unknown age), not a server fault.
        if (error instanceof PersonAgreementError) throw new ApiResponseError(409, error.message);
        throw error;
    }
});
