import { NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import { withAuth } from "@/lib/auth";
import { certifyPaymentPlan, PaymentError } from "@/lib/membership/payment";
import { apiError } from "@/lib/api-response";
import { paymentErrorResponse } from "@/lib/domainErrorResponse";
import prisma from "@/lib/prisma";
import { grantableYears } from "@/lib/programYear";
import { orgToday } from "@/lib/appSettings";

export const dynamic = "force-dynamic";

/**
 * POST /api/membership-ops/applications/certify-payment — board-only override.
 * Certifies a payment plan and activates the membership without a Shopify payment.
 * Body: { processId, reason, year, acknowledgeYearMismatch? }. `year` is the
 * membership year the payment is for, one the grant action may record; a year
 * other than the application's own needs `acknowledgeYearMismatch: true`.
 */
export const POST = withAuth({ roles: ["isBoardMember"] }, async (req, auth) => {
    if (auth.type !== "session") return apiError("Unauthorized", 401);
    let body: { processId?: number; reason?: string; year?: unknown; acknowledgeYearMismatch?: unknown };
    try {
        body = await req.json();
    } catch {
        return apiError("Invalid JSON", 400);
    }
    if (!body.processId) return apiError("processId is required", 400);
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    if (!reason) return apiError("A reason is required to certify a payment", 400);
    const year = body.year;
    if (typeof year !== "number" || !Number.isInteger(year)) return apiError("Choose the membership year this payment is for.", 400);
    const settings = await prisma.boardSettings.findUnique({ where: { id: 1 }, select: { orgMembershipYearBoundary: true } });
    if (!grantableYears(settings?.orgMembershipYearBoundary, await orgToday()).some((y) => y.year === year)) {
        return apiError("That membership year can't be recorded now. Reload the page and try again.", 400);
    }
    try {
        const process = await certifyPaymentPlan(body.processId, auth.user.id, { reason, year, acknowledgeYearMismatch: body.acknowledgeYearMismatch === true });
        return NextResponse.json({ process });
    } catch (error) {
        if (error instanceof PaymentError) {
            return paymentErrorResponse(error);
        }
        logger.error("Certify payment error:", error);
        return apiError("Internal Server Error", 500);
    }
});
