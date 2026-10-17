import { NextResponse } from "next/server";
import { withAuth } from "@/lib/auth";
import { logger } from "@/lib/logger";
import { selfRecordBgConsent, ExternalError, type ExternalErrorCode } from "@/lib/membership/external";
import { apiError } from "@/lib/api-response";

export const dynamic = "force-dynamic";

// HTTP status per ExternalError code (mirrors contract/sign). The 503 codes are
// Zoho-only and unreachable from this route, but the Record keeps the map total.
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
 * POST /api/membership/bg-consent — applicant-facing "I submitted my consent on
 * Averity" self-report (#875). Records consent on the caller's own process
 * awaiting external action via markBgConsent (applicant as audit actor), which
 * may advance the application to PENDING_PAYMENT. Honor-system by design; the
 * board's mark-bg-consent remains the backstop.
 */
export const POST = withAuth({}, async (_req, auth) => {
    if (auth.type !== "session") return apiError("Unauthorized", 401);
    try {
        const status = await selfRecordBgConsent(auth.user.id);
        return NextResponse.json({ status });
    } catch (error) {
        if (error instanceof ExternalError) {
            return NextResponse.json({ error: error.message, code: error.code }, { status: STATUS_BY_CODE[error.code] });
        }
        logger.error(`Membership bg-consent error: ${error instanceof Error ? error.message : String(error)}`);
        return apiError("Internal Server Error", 500);
    }
});
