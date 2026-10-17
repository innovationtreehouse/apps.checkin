import { NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import prisma from "@/lib/prisma";
import { withAuth } from "@/lib/auth";
import { apiError } from "@/lib/api-response";
import { hasHouseholdConflict } from "@/lib/conflictOfInterest";
import { fromWhere } from "@/lib/programs/enrollmentState";

// Denies a pending scholarship / payment-plan request — the sibling of
// POST /api/finance-ops/payment-plans (approve) this branch previously lacked.
// The participant stays PENDING and keeps their held seat (product decision
// 2026-07-06, hold-ledger): a denial performs NO Shopify operation — the seat
// stays out of Shopify's pool exactly as the application left it, so the
// applicant may still pay normally. This supersedes the earlier deny-time +1
// (that let the seat re-sell out from under a denied-but-not-withdrawn
// applicant). The hold is released, exactly once, by whichever of withdrawal /
// normal payment / grace-period expiry fires first (see
// docs/PROGRAM_CAPACITY_AND_SCHOLARSHIPS.md).
export const POST = withAuth(
    { roles: ['isBoardMember'] },
    async (req, auth) => {
        try {
            const body = await req.json();
            const programId = parseInt(body.programId, 10);
            const participantId = parseInt(body.participantId, 10);

            if (Number.isNaN(programId) || Number.isNaN(participantId)) {
                return apiError("programId and participantId are required", 400);
            }

            // Conflict of interest: mirrors approve — no actor may refuse their OWN
            // household's request either. No role bypasses this.
            if (auth.type === 'session') {
                const target = await prisma.person.findUnique({ where: { id: participantId }, select: { householdId: true } });
                if (await hasHouseholdConflict(prisma, auth.user.id, target?.householdId)) {
                    return apiError("You cannot refuse your own household's payment plan — someone outside your household must.", 403);
                }
            }

            const data = { isPaymentPlanRequested: false, paymentPlanDeniedAt: new Date() };

            // Scope to the pending request so refusing a non-pending/nonexistent
            // request is a no-op error, mirroring approve's guard. Transactional
            // true->false guard: a double-refuse (already false) 409s instead of
            // re-stamping paymentPlanDeniedAt.
            const { count } = await prisma.programParticipant.updateMany({
                // T6 deny CAS: from-state status from the definition (#1080); isPaymentPlanRequested stays literal.
                where: { programId, personId: participantId, isPaymentPlanRequested: true, ...fromWhere('PENDING_HELD') },
                data,
            });

            if (count === 0) {
                return apiError("No pending payment-plan request", 409);
            }

            if (auth.type === 'session') {
                await prisma.auditLog.create({
                    data: {
                        actorId: auth.user.id,
                        action: "EDIT",
                        tableName: "ProgramParticipant",
                        affectedEntityId: participantId,
                        secondaryAffectedEntity: programId,
                        newData: data,
                    },
                });
            }

            // Denial is deliberately silent — no automatic applicant email (user
            // decision: the ack at request time is the only automatic applicant
            // email; the board communicates decisions, including this one, manually).
            // That means the scholarshipDenialGraceDays clock (§4) now starts
            // without any notice to the applicant.

            return NextResponse.json({ success: true });
        } catch (error) {
            logger.error("Failed to refuse payment plan:", error);
            return apiError("Failed to refuse payment plan", 500);
        }
    }
);
