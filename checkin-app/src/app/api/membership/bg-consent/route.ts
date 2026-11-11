import { NextResponse } from "next/server";
import { withAuth } from "@/lib/auth";
import { logger } from "@/lib/logger";
import { selfRecordBgConsent, ExternalError } from "@/lib/membership/external";
import { apiError } from "@/lib/api-response";
import { externalErrorResponse } from "@/lib/domainErrorResponse";

export const dynamic = "force-dynamic";

/**
 * POST /api/membership/bg-consent — applicant-facing "I submitted my consent on
 * Averity" self-report. Records consent via markBgConsent (applicant as
 * audit actor) on a lead's household process awaiting external action, which may
 * advance it to PENDING_PAYMENT, or else on the caller's own open PERSON_BG
 * obligation. Honor-system by design; the
 * board's mark-bg-consent remains the backstop.
 */
export const POST = withAuth({}, async (_req, auth) => {
    if (auth.type !== "session") return apiError("Unauthorized", 401);
    try {
        const status = await selfRecordBgConsent(auth.user.id);
        return NextResponse.json({ status });
    } catch (error) {
        if (error instanceof ExternalError) {
            return externalErrorResponse(error);
        }
        logger.error(`Membership bg-consent error: ${error instanceof Error ? error.message : String(error)}`);
        return apiError("Internal Server Error", 500);
    }
});
