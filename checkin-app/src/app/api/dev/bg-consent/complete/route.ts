import { NextResponse } from "next/server";
import { withAuth } from "@/lib/auth";
import { config } from "@/lib/config";
import prisma from "@/lib/prisma";
import { markBgConsent, ExternalError } from "@/lib/membership/external";
import { latestPendingExternal } from "@/lib/membership/phases";
import { apiError } from "@/lib/api-response";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

/**
 * POST /api/dev/bg-consent/complete — dev-only consent trigger for the background-check
 * mock (see docs/ops/background-check-mock.md). Reached from the dev interstitial's
 * "Consent" button, standing in for the applicant consenting on Averity. Records real
 * consent (markBgConsent) on the caller's own in-flight application, driving the same
 * advance → parallel board review path prod does.
 *
 * 404s whenever the mock isn't active — always in prod.
 */
export const POST = withAuth({}, async (_req, auth) => {
    if (!config.bgMockActive()) return apiError("Not available", 404);
    if (auth.type !== "session") return apiError("Unauthorized", 401);
    const userId = auth.user.id;

    const user = await prisma.person.findUnique({
        where: { id: userId },
        include: { household: { include: { orgMembership: { include: { processes: true } } } } },
    });
    const process = latestPendingExternal(user?.household?.orgMembership?.processes);
    if (!process) return apiError("No application is awaiting background-check consent.", 404);

    try {
        return NextResponse.json({ process: await markBgConsent(process.id, userId) });
    } catch (error) {
        if (error instanceof ExternalError) {
            return NextResponse.json({ error: error.message, code: error.code }, { status: 400 });
        }
        logger.error("Dev bg-consent complete error:", error);
        return apiError("Internal Server Error", 500);
    }
});
