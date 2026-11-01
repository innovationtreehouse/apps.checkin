import { NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import prisma from "@/lib/prisma";
import { withAuth } from "@/lib/auth";
import { apiError } from "@/lib/api-response";
import { ENROLLMENT_WRITES } from "@/lib/programs/enrollmentState";

// Board manual-hold confirmation for a PENDING_HOLD_FAILED row (the apply-time
// Shopify -1 failed, so { status: PENDING, inventoryHeldAt: null,
// isPaymentPlanRequested: true, paymentPlanDeniedAt: null } — no seat is actually
// out of Shopify's pool). The board member removes the seat in Shopify BY HAND,
// then confirms here. This confirmation stamps inventoryHeldAt=<now>, moving the
// row into the normal PENDING_HELD state so the ordinary approve/deny flow
// resumes.
//
// IMPORTANT: this does NOT call Shopify. inventoryHeldAt means "a real seat is out
// of Shopify's pool," so the stamp is only trustworthy because the human already
// did the decrement manually — the UI copy makes that precondition explicit.
//
// No conflict-of-interest gate (unlike approve/refuse): confirming a manual hold
// confers no benefit on the applicant — it only records a seat the board already
// removed, and the value-conferring approve step keeps its own CoI check.
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

            const heldAt = new Date();

            // Compare-and-set on the exact PENDING_HOLD_FAILED tuple: only a row
            // that is still PENDING, still requested, and still unheld flips. A
            // concurrent approve/deny/manual-hold that already moved it 409s
            // instead of double-stamping.
            const { count } = await prisma.programParticipant.updateMany({
                where: { programId, personId: participantId, ...ENROLLMENT_WRITES.manualHold.where },
                data: ENROLLMENT_WRITES.manualHold.data(heldAt),
            });

            if (count === 0) {
                return apiError("No hold-failed request to reconcile", 409);
            }

            if (auth.type === 'session') {
                await prisma.auditLog.create({
                    data: {
                        actorId: auth.user.id,
                        action: "EDIT",
                        tableName: "ProgramParticipant",
                        affectedEntityId: participantId,
                        secondaryAffectedEntity: programId,
                        newData: ENROLLMENT_WRITES.manualHold.data(heldAt),
                    },
                });
            }

            return NextResponse.json({ success: true });
        } catch (error) {
            logger.error("Failed to confirm manual hold:", error);
            return apiError("Failed to confirm manual hold", 500);
        }
    }
);
