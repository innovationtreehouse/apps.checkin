import { NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import prisma from "@/lib/prisma";
import { withAuth } from "@/lib/auth";
import { apiError } from "@/lib/api-response";
import { hasHouseholdConflict } from "@/lib/conflictOfInterest";
import { fromWhere } from "@/lib/membership/lifecycle";

// Denies a pending membership scholarship / payment-plan request — the sibling
// of POST /api/finance-ops/membership-payment-plans (approve) that membership
// previously lacked, so a declined request had no board action and sat
// PENDING_PAYMENT on the queue indefinitely. This gives the board a dedicated
// deny control (docs/PROGRAM_CAPACITY_AND_SCHOLARSHIPS.md §5 item 4).
//
// Silent by design, like every other board decision (approve on both sides,
// program deny): sends NO automatic applicant email — the Scholarship Review
// Team communicates the outcome manually. Denial is purely clearing
// isPaymentPlanRequested back to false: the process stays PENDING_PAYMENT and
// the household returns to normal "pay your membership fee to activate". Membership holds
// no Shopify seat and has no grace-expiry cron (grace is program-only), so there
// is no seat to release and no paymentPlanDeniedAt to stamp — OrgMembershipProcess
// has no such column and needs none; the cleared flag is the whole of denial state.
export const POST = withAuth(
    { roles: ['isBoardMember'] },
    async (req, auth) => {
        let body;
        try {
            body = await req.json();
        } catch {
            return apiError("Invalid JSON", 400);
        }

        try {
            const processId = parseInt(body.processId, 10);

            if (Number.isNaN(processId)) {
                return apiError("processId is required", 400);
            }

            // Probe the process itself (not just the target household) so a
            // nonexistent processId gets a real 404, mirroring the program refuse
            // route's probe order.
            const process = await prisma.orgMembershipProcess.findUnique({
                where: { id: processId },
                select: { orgMembership: { select: { householdId: true } } },
            });
            if (!process) {
                return apiError("Membership application not found", 404);
            }

            // Conflict of interest: mirrors certifyPaymentPlan (approve) — no actor may
            // deny their OWN household's request either. No role bypasses this.
            if (auth.type === 'session') {
                if (await hasHouseholdConflict(prisma, auth.user.id, process.orgMembership?.householdId)) {
                    return apiError("You cannot deny your own household's payment plan — someone outside your household must.", 403);
                }
            }

            // Only act on a genuinely-requested, still-awaiting-payment process, so
            // denying a stale/already-denied request 409s, mirroring the approve
            // route's probe. Transactional true->false guard inside $transaction: the
            // CAS and its audit row commit together, and a double-deny (already
            // false) leaves count at 0 with no audit row written.
            const count = await prisma.$transaction(async (tx) => {
                const { count } = await tx.orgMembershipProcess.updateMany({
                    // Deny CAS: from-state status from the definition (#1080); isPaymentPlanRequested stays literal.
                    where: { id: processId, isPaymentPlanRequested: true, ...fromWhere('PENDING_PAYMENT') },
                    data: { isPaymentPlanRequested: false },
                });
                if (count === 1 && auth.type === 'session') {
                    await tx.auditLog.create({
                        data: {
                            actorId: auth.user.id,
                            action: "EDIT",
                            tableName: "OrgMembershipProcess",
                            affectedEntityId: processId,
                            newData: { paymentPlanDenied: true, isPaymentPlanRequested: false },
                        },
                    });
                }
                return count;
            });

            if (count === 0) {
                return apiError("No pending payment-plan request", 409);
            }

            // Deny sends NO automatic email (notification contract: the request ack
            // is the applicant's only automatic email; the board communicates the
            // denial manually).

            return NextResponse.json({ success: true });
        } catch (error) {
            logger.error("Failed to refuse membership payment plan:", error);
            return apiError("Failed to refuse payment plan", 500);
        }
    }
);
