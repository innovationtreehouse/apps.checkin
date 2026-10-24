import { NextResponse } from "next/server";
import { withAuth } from "@/lib/auth";
import { logger } from "@/lib/logger";
import { getOrCreateContractSigningUrl, ExternalError, type ExternalErrorCode } from "@/lib/membership/external";
import { apiError } from "@/lib/api-response";

export const dynamic = "force-dynamic";

// HTTP status per ExternalError code. 503 = integration not ready yet (secrets or
// the agreement PDF — issue #289); the applicant sees a "check back soon" message.
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
 * POST /api/membership/contract/sign — applicant-facing "Sign your membership
 * agreement" action. Creates the Zoho signing request once (stored on the
 * process) and returns a fresh embedded sign URL to redirect the applicant into.
 */
export const POST = withAuth({}, async (_req, auth) => {
    if (auth.type !== "session") return apiError("Unauthorized", 401);
    try {
        const url = await getOrCreateContractSigningUrl(auth.user.id);
        return NextResponse.json({ url });
    } catch (error) {
        if (error instanceof ExternalError) {
            return NextResponse.json({ error: error.message, code: error.code }, { status: STATUS_BY_CODE[error.code] });
        }
        logger.error(`Membership contract sign error: ${error instanceof Error ? error.message : String(error)}`);
        return apiError("Internal Server Error", 500);
    }
});
