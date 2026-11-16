import { NextResponse } from "next/server";
import { withAuth } from "@/lib/auth";
import { config } from "@/lib/config";
import { ExternalError } from "@/lib/membership/external";
import { markCheckStarted } from "@/lib/membership/checkStarted";
import { apiError } from "@/lib/api-response";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

/**
 * POST /api/dev/bg-consent/complete — dev-only consent trigger for the background-check
 * mock (see docs/ops/background-check-mock.md). Reached from the dev interstitial's
 * "Consent" button, standing in for the applicant consenting on Averity. Marks the
 * caller's own check started (markCheckStarted), driving the same review-queue and
 * advance path prod does.
 *
 * 404s whenever the mock isn't active — always in prod.
 */
export const POST = withAuth({}, async (_req, auth) => {
    if (!config.bgMockActive()) return apiError("Not available", 404);
    if (auth.type !== "session") return apiError("Unauthorized", 401);
    const userId = auth.user.id;

    try {
        return NextResponse.json(await markCheckStarted(userId, userId));
    } catch (error) {
        if (error instanceof ExternalError) {
            return NextResponse.json({ error: error.message, code: error.code }, { status: 400 });
        }
        logger.error("Dev bg-consent complete error:", error);
        return apiError("Internal Server Error", 500);
    }
});
