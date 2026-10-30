import { ApiResponseError, handler, unauthorized } from "@/security/handler";
import { ExternalError, type ExternalErrorCode } from "@/lib/membership/external";
import { startKeyVolunteerSigning } from "@/lib/membership/keyVolunteer";

export const dynamic = "force-dynamic";

// 503 = signing or the agreement document not ready; the page says to check back.
const STATUS_BY_CODE: Record<ExternalErrorCode, number> = {
    not_configured: 503,
    agreement_unavailable: 503,
    not_found: 404,
    no_household: 404,
    not_lead: 403,
    wrong_phase: 409,
    signing_in_progress: 409,
};

/**
 * POST /api/membership/key-volunteer/sign — the embedded sign URL for the
 * caller's own open Key Volunteer Agreement. The first call creates the Zoho
 * request; later calls reuse it.
 */
export const POST = handler("POST /api/membership/key-volunteer/sign", async ({ auth }) => {
    if (auth.type !== "session") throw unauthorized();
    try {
        return { KeyVolunteerSigning: await startKeyVolunteerSigning(auth.user.id) };
    } catch (error) {
        if (error instanceof ExternalError) throw new ApiResponseError(STATUS_BY_CODE[error.code], error.message);
        throw error;
    }
});
