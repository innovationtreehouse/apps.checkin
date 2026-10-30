import { NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import { withAuth } from "@/lib/auth";
import { withdrawTrustedAdult, TrustedAdultError } from "@/lib/trusted-adult/service";
import { apiError } from "@/lib/api-response";
import { trustedAdultErrorResponse } from "@/lib/domainErrorResponse";

export const dynamic = "force-dynamic";

/**
 * POST /api/trusted-adults/[id]/withdraw — subject (or their household lead)
 * retracts a disclosure. Body { scope }: "change" cancels only the pending change
 * on top (keeping a live prior approval); default "all" revokes every live review.
 */
export const POST = withAuth({}, async (req, auth) => {
    if (auth.type !== "session") return apiError("Unauthorized", 401);
    const id = parseInt(req.nextUrl.pathname.split("/").at(-2) ?? "", 10);
    if (isNaN(id)) return apiError("Invalid id", 400);
    try {
        const body = await req.json().catch(() => ({}));
        await withdrawTrustedAdult(id, auth.user.id, { latestReviewOnly: body.scope === "change" });
        return NextResponse.json({ ok: true });
    } catch (error) {
        if (error instanceof TrustedAdultError) {
            return trustedAdultErrorResponse(error);
        }
        logger.error("Trusted adult withdraw error:", error);
        return apiError("Internal Server Error", 500);
    }
});
