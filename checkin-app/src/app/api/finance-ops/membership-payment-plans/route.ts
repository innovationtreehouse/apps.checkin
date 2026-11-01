import { NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import prisma from "@/lib/prisma";
import { withAuth } from "@/lib/auth";
import { handler } from "@/security/handler";
import { apiError } from "@/lib/api-response";
import { PAYMENT_ERROR_STATUS } from "@/lib/domainErrorResponse";
import { certifyPaymentPlan, PaymentError } from "@/lib/membership/payment";
import { fromWhere } from "@/lib/membership/lifecycle";
import { LIVE_PERSON } from "@/lib/person/filters";

export const GET = handler('GET /api/finance-ops/membership-payment-plans', async () => {
    const requests = await prisma.orgMembershipProcess.findMany({
        // Queue read = the PENDING_PAYMENT from-state the POST acts on; status from the definition.
        where: {
            isPaymentPlanRequested: true,
            ...fromWhere('PENDING_PAYMENT'),
        },
        // Selects stay narrow: finance holds everyones:pii here for the lead
        // emails, so any other column selected (the intake note, its snapshot on
        // the process) would reach them too.
        select: {
            id: true,
            stageEnteredAt: true,
            scholarshipRequestKind: true,
            orgMembership: {
                select: {
                    id: true,
                    isVolunteerFamily: true,
                    household: {
                        select: {
                            id: true,
                            name: true,
                            householdMembers: {
                                where: { isHouseholdLead: true, ...LIVE_PERSON },
                                select: { id: true, name: true, email: true },
                            },
                        },
                    },
                },
            },
        },
        orderBy: {
            stageEnteredAt: 'asc',
        },
    });

    return { OrgMembershipProcess: requests };
});

export const POST = withAuth(
    { roles: ['isBoardMember'] },
    async (req, auth) => {
        try {
            const body = await req.json();
            const processId = parseInt(body.processId, 10);
            const reason = typeof body.reason === "string" ? body.reason.trim() : "";

            if (Number.isNaN(processId)) {
                return apiError("processId is required", 400);
            }
            if (!reason) {
                return apiError("A reason is required to certify a payment", 400);
            }
            if (auth.type !== 'session') {
                return apiError("Unauthorized", 401);
            }

            // Certifies the plan and activates without a Shopify payment (holding for
            // background clearance if not yet cleared). Under the row lock it refuses a
            // request no longer open, and closes this one with its audit row.
            await certifyPaymentPlan(processId, auth.user.id, { reason, requireRequested: true });

            return NextResponse.json({ success: true });
        } catch (error) {
            if (error instanceof PaymentError) {
                return apiError(error.message, PAYMENT_ERROR_STATUS[error.code]);
            }
            logger.error("Failed to approve membership payment plan:", error);
            return apiError("Failed to approve payment plan", 500);
        }
    }
);
