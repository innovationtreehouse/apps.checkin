import { NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import { withAuth } from "@/lib/auth";
import { resubmitWithChanges, TrustedAdultError } from "@/lib/trusted-adult/service";
import { apiError } from "@/lib/api-response";
import { trustedAdultErrorResponse } from "@/lib/domainErrorResponse";

export const dynamic = "force-dynamic";

/**
 * POST /api/trusted-adults/[id]/resubmit — resubmit with CHANGED info. Body carries
 * the edited name/contact/context. Opens a MODIFIED board review that holds the
 * proposed edits; a live prior approval is untouched until the board approves. Household lead only.
 */
export const POST = withAuth({}, async (req, auth) => {
    if (auth.type !== "session") return apiError("Unauthorized", 401);
    const id = parseInt(req.nextUrl.pathname.split("/").at(-2) ?? "", 10);
    if (isNaN(id)) return apiError("Invalid id", 400);
    try {
        const body = await req.json().catch(() => ({}));
        const review = await resubmitWithChanges(id, auth.user.id, {
            trustedAdultName: body.trustedAdultName,
            trustedAdultPhone: body.trustedAdultPhone,
            trustedAdultEmail: body.trustedAdultEmail,
            familyContext: body.familyContext,
        });
        return NextResponse.json({ reviewId: review.id });
    } catch (error) {
        if (error instanceof TrustedAdultError) {
            return trustedAdultErrorResponse(error);
        }
        logger.error("Trusted adult resubmit error:", error);
        return apiError("Internal Server Error", 500);
    }
});
