import { NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import { withAuth } from "@/lib/auth";
import { renewTrustedAdult, TrustedAdultError } from "@/lib/trusted-adult/service";
import { apiError } from "@/lib/api-response";
import { trustedAdultErrorResponse } from "@/lib/domainErrorResponse";

export const dynamic = "force-dynamic";

/**
 * POST /api/trusted-adults/[id]/renew — one-click resubmit. No body: reuses every
 * fact on the link and opens a fresh board review. Subject or household lead only.
 */
export const POST = withAuth({}, async (req, auth) => {
    if (auth.type !== "session") return apiError("Unauthorized", 401);
    const id = parseInt(req.nextUrl.pathname.split("/").at(-2) ?? "", 10);
    if (isNaN(id)) return apiError("Invalid id", 400);
    try {
        const review = await renewTrustedAdult(id, auth.user.id);
        return NextResponse.json({ reviewId: review.id });
    } catch (error) {
        if (error instanceof TrustedAdultError) {
            return trustedAdultErrorResponse(error);
        }
        logger.error("Trusted adult renew error:", error);
        return apiError("Internal Server Error", 500);
    }
});
