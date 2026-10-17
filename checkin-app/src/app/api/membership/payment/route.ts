import { NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import { withAuth } from "@/lib/auth";
import { householdLeadship } from "@/lib/household/leads";
import { ensurePaymentLinkForUser, PaymentError } from "@/lib/membership/payment";
import { apiError } from "@/lib/api-response";

export const dynamic = "force-dynamic";

// GET /api/membership/payment — the caller's membership fee amount + Shopify checkout link.
export const GET = withAuth({}, async (_req, auth) => {
    if (auth.type !== "session") return apiError("Unauthorized", 401);

    // The membership fee figure and the live checkout link are the household lead's to see
    // (canManage folds in sysadmin), plus the board — matching request-payment-plan.
    // Every other household member, youth included, resolves the same household
    // here, so without this gate they would get the amount and the checkout URL.
    const household = await householdLeadship(auth.user.id);
    if (!household?.canManage && !auth.user.isBoardMember) {
        return apiError("Forbidden: Only a household lead can view the membership fee", 403);
    }

    try {
        return NextResponse.json(await ensurePaymentLinkForUser(auth.user.id));
    } catch (error) {
        if (error instanceof PaymentError) {
            return NextResponse.json({ error: error.message, code: error.code }, { status: error.code === "not_found" ? 404 : 409 });
        }
        logger.error("Payment link error:", error);
        return apiError("Internal Server Error", 500);
    }
});
