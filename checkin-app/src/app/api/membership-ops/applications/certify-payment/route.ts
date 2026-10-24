import { NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import { withAuth } from "@/lib/auth";
import { certifyPaymentPlan, PaymentError } from "@/lib/membership/payment";
import { apiError } from "@/lib/api-response";

export const dynamic = "force-dynamic";

/**
 * POST /api/membership-ops/applications/certify-payment — board-only override.
 * Certifies a payment plan and activates the membership without a Shopify payment.
 * Body: { processId, reason }
 */
export const POST = withAuth({ roles: ["isBoardMember"] }, async (req, auth) => {
    if (auth.type !== "session") return apiError("Unauthorized", 401);
    let body: { processId?: number; reason?: string };
    try {
        body = await req.json();
    } catch {
        return apiError("Invalid JSON", 400);
    }
    if (!body.processId) return apiError("processId is required", 400);
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    if (!reason) return apiError("A reason is required to certify a payment", 400);
    try {
        const process = await certifyPaymentPlan(body.processId, auth.user.id, { reason });
        return NextResponse.json({ process });
    } catch (error) {
        if (error instanceof PaymentError) {
            const status = error.code === "not_found" ? 404 : error.code === "forbidden" ? 403 : 409;
            return NextResponse.json({ error: error.message, code: error.code }, { status });
        }
        logger.error("Certify payment error:", error);
        return apiError("Internal Server Error", 500);
    }
});
