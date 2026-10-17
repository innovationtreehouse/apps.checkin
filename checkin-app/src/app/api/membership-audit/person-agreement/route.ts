import { handler, ApiResponseError, badRequest, unauthorized } from "@/security/handler";
import { openPersonAgreementForBoard, PersonAgreementError } from "@/lib/membership/personAgreementTriggers";

export const dynamic = "force-dynamic";

/**
 * POST /api/membership-audit/person-agreement — board/sysadmin opens an individual
 * membership agreement for one adult child. Body: { personId }.
 *
 * The escape hatch for people the nightly rule doesn't reach: not program-attached, or
 * over its age ceiling (the board can tell an adult child from a spouse; the automatic
 * rule can't). Still refuses a household lead — they sign the household agreement, and an
 * open PERSON_AGREEMENT on a lead would shadow it — and still refuses an unknown age.
 * Idempotent: an obligation already open for this cycle is returned as-is.
 *
 * Responds with the obligation's id/kind/status only. Nothing identifying the subject
 * goes back out: the caller already named them.
 */
export const POST = handler("POST /api/membership-audit/person-agreement", async ({ req, auth }) => {
    if (auth.type !== "session") throw unauthorized();

    let body: { personId?: number };
    try {
        body = await req.json();
    } catch {
        throw badRequest("Invalid JSON");
    }
    if (!body.personId) throw badRequest("personId is required");

    try {
        const process = await openPersonAgreementForBoard(body.personId, auth.user.id);
        return { OrgMembershipProcess: { id: process.id, kind: process.kind, status: process.status } };
    } catch (error) {
        // A refusal the board needs to read (lead / unknown age), not a server fault.
        if (error instanceof PersonAgreementError) throw new ApiResponseError(409, error.message);
        throw error;
    }
});
