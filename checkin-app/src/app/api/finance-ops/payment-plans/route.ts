import { NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import prisma from "@/lib/prisma";
import { withAuth } from "@/lib/auth";
import { handler } from "@/security/handler";
import { apiError } from "@/lib/api-response";
import { isActiveOrgMember } from "@/lib/orgMembership";
import { hasHouseholdConflict } from "@/lib/conflictOfInterest";
import { ENROLLMENT_WRITES, STATES } from "@/lib/programs/enrollmentState";
import type { Prisma } from "@/generated/prisma/client";

// Two DISJOINT board queues over PENDING + isPaymentPlanRequested rows, split on
// whether a Shopify seat is actually held (inventoryHeldAt):
//   default            → the scholarship queue: genuine held-and-awaiting requests
//                        (inventoryHeldAt set, paymentPlanDeniedAt null). Approve/deny act here.
//   ?queue=holds       → the Shopify reconciliation queue: PENDING_HOLD_FAILED rows
//                        (inventoryHeldAt null) — the apply-time -1 failed, so no seat
//                        was ever removed. The board resolves these via manual-hold.
// One endpoint (one security-boundary entry, one stripper policy) returning two
// non-overlapping sets — NOT one list with both mixed in.
export const GET = handler('GET /api/finance-ops/payment-plans', async ({ req }) => {
    const holdsQueue = new URL(req.url).searchParams.get('queue') === 'holds';
    const [requests, boardSettings] = await Promise.all([
        prisma.programParticipant.findMany({
            // The two queues ARE two lifecycle states (enrollmentState §3): the
            // scholarship queue is PENDING_HELD, the reconciliation queue is
            // PENDING_HOLD_FAILED. Consume the definition's `where` so the split
            // can't drift from the state table.
            where: { ...(holdsQueue ? STATES.PENDING_HOLD_FAILED.where : STATES.PENDING_HELD.where) },
            include: {
                // Nests household→orgMembership so the board can see CURRENT
                // membership while a request is still pending —
                // wasOrgMemberAtApproval is null until approved, so it can't
                // answer this. Derive live client-side; nothing new to stamp.
                // householdMembers (leads) carry the family contact email.
                // Selects stay narrow: finance holds everyones:pii here for the
                // contact emails, so any other Person/Household column selected
                // (intake note, date of birth, allergies) would reach them too.
                person: {
                    select: {
                        id: true,
                        name: true,
                        email: true,
                        householdId: true,
                        household: {
                            select: {
                                id: true,
                                orgMembership: { select: { status: true } },
                                householdMembers: {
                                    where: { isHouseholdLead: true },
                                    select: { id: true, name: true, email: true },
                                },
                            },
                        },
                    },
                },
                // startAt is half of the next-year flag.
                program: {
                    select: { id: true, name: true, startAt: true, orgMemberPriceCents: true, nonOrgMemberPriceCents: true },
                },
            },
            orderBy: {
                pendingSince: 'asc'
            }
        }),
        // The membership-year cutoff. Shipped so the board can flag requests whose
        // program lands in the NEXT membership year (program.startAt >= next cutoff).
        // Derived on the client, not stamped: the security stripper drops ad-hoc
        // booleans, so we ship the two classified inputs (startAt + this boundary)
        // and compare client-side — same pattern as the Member/Non-member column.
        prisma.boardSettings.findUnique({ where: { id: 1 } })
    ]);

    return { ProgramParticipant: requests, BoardSettings: boardSettings };
});

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

            if (auth.type !== 'session') {
                return apiError("Unauthorized", 401);
            }

            // Conflict of interest: no actor may approve their OWN household's program
            // payment plan (activate an enrollment without payment for their own
            // family). No role bypasses this.
            const target = await prisma.person.findUnique({ where: { id: participantId }, select: { householdId: true } });
            if (await hasHouseholdConflict(prisma, auth.user.id, target?.householdId)) {
                return apiError("You cannot approve your own household's payment plan — someone outside your household must.", 403);
            }

            // Point-in-time snapshot: membership status changes over time, so this
            // must be stamped now, at approval — not derived later from the live
            // OrgMembership row. Reuses the canonical org-member check (lib/orgMembership.ts).
            const wasOrgMemberAtApproval = await isActiveOrgMember(participantId);

            const approval = { pendingSince: null, wasOrgMemberAtApproval };

            // Scope to the pending request so approving a non-pending/nonexistent
            // request is a no-op error, mirroring the GET queue's filter.
            const participant = { programId, personId: participantId };
            // A held seat carries over as seatTakenWithoutSaleAt, so withdrawal can
            // return it. A request whose hold failed took no seat and records none.
            const approved = await prisma.$transaction(async (tx) => {
                const seatTakenWithoutSaleAt = new Date();
                const held = await tx.programParticipant.updateMany({
                    where: { ...participant, ...ENROLLMENT_WRITES.approveHeld.where },
                    data: { ...ENROLLMENT_WRITES.approveHeld.data(), ...approval, seatTakenWithoutSaleAt },
                });

                let auditData: Prisma.InputJsonObject = { ...ENROLLMENT_WRITES.approveHeld.data(), ...approval, seatTakenWithoutSaleAt };
                if (held.count === 0) {
                    const unheld = await tx.programParticipant.updateMany({
                        where: { ...participant, ...ENROLLMENT_WRITES.approveUnheld.where },
                        data: { ...ENROLLMENT_WRITES.approveUnheld.data(), ...approval },
                    });
                    if (unheld.count === 0) return false;
                    auditData = { ...ENROLLMENT_WRITES.approveUnheld.data(), ...approval, reason: "payment_plan_approved_no_hold" };
                }

                await tx.auditLog.create({
                    data: {
                        actorId: auth.user.id,
                        action: "EDIT",
                        tableName: "ProgramParticipant",
                        affectedEntityId: participantId,
                        secondaryAffectedEntity: programId,
                        newData: auditData,
                    },
                });
                return true;
            });

            if (!approved) {
                return apiError("No pending payment-plan request", 409);
            }

            // Scholarship lifecycle drives inventory: the seat was already
            // decremented from Shopify at APPLICATION time
            // (POST .../request-payment-plan), so approval performs NO Shopify
            // operation — the applicant already holds the seat; approval just
            // stops billing them for it. An approve-time decrement would
            // double-count against the apply-time one.
            return NextResponse.json({ success: true });
        } catch (error) {
            logger.error("Failed to approve payment plan:", error);
            return apiError("Failed to approve payment plan", 500);
        }
    }
);
