import { NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import prisma from "@/lib/prisma";
import { withAuth } from "@/lib/auth";
import { handler } from "@/security/handler";
import { apiError } from "@/lib/api-response";
import { certifyPaymentPlan, PaymentError } from "@/lib/membership/payment";
import { fromWhere } from "@/lib/membership/lifecycle";
import { LIVE_PERSON } from "@/lib/person/filters";

export const GET = handler('GET /api/finance-ops/membership-payment-plans', async () => {
    const requests = await prisma.orgMembershipProcess.findMany({
        // Queue read = the PENDING_PAYMENT from-state the POST acts on; status from the definition (#1080).
        where: {
            isPaymentPlanRequested: true,
            ...fromWhere('PENDING_PAYMENT'),
        },
        include: {
            orgMembership: {
                include: {
                    household: {
                        include: {
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

            // Only act on a genuinely-requested, still-awaiting-payment process, so
            // approving a stale/nonexistent request is a no-op error, mirroring the
            // GET queue's filter.
            const process = await prisma.orgMembershipProcess.findFirst({
                // Approve probe: from-state status from the definition (#1080); isPaymentPlanRequested stays literal.
                where: { id: processId, isPaymentPlanRequested: true, ...fromWhere('PENDING_PAYMENT') },
                select: { id: true },
            });
            if (!process) {
                return apiError("No pending payment-plan request", 409);
            }

            // Reuse the membership activation path: certifies the plan and activates
            // without a Shopify payment (holding for background clearance if not yet
            // cleared). Then clear the request flag so it drops off the queue.
            await certifyPaymentPlan(processId, auth.user.id, { reason });
            await prisma.orgMembershipProcess.update({
                where: { id: processId },
                data: { isPaymentPlanRequested: false },
            });

            await prisma.auditLog.create({
                data: {
                    actorId: auth.user.id,
                    action: "EDIT",
                    tableName: "OrgMembershipProcess",
                    affectedEntityId: processId,
                    newData: { paymentPlanApproved: true, isPaymentPlanRequested: false },
                },
            });

            return NextResponse.json({ success: true });
        } catch (error) {
            if (error instanceof PaymentError) {
                return apiError(error.message, error.code === "not_found" ? 404 : error.code === "forbidden" ? 403 : 409);
            }
            logger.error("Failed to approve membership payment plan:", error);
            return apiError("Failed to approve payment plan", 500);
        }
    }
);
