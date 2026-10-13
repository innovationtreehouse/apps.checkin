import { NextRequest, NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import prisma from "@/lib/prisma";
import { withAuth } from "@/lib/auth";
import { apiError } from "@/lib/api-response";
import { resolveActorHouseholdId, sharesHousehold } from "@/lib/conflictOfInterest";
import { ordersByLegacyIds, type MirrorOrder } from "@/lib/shopifyRead/client";

/**
 * PATCH /api/finance-ops/payments/[id] — the board acknowledges or resolves one
 * reconciler-detected payment problem.
 *   acknowledge → status ACKNOWLEDGED (seen, not yet cleared).
 *   resolve     → status RESOLVED, stamped with who/when + a note.
 * Only a real session may act (mirrors the payment-plans route); every change is
 * audit-logged since the actor is not the affected household.
 */
export const PATCH = withAuth<{ params: Promise<{ id: string }> }>(
    { roles: ['isBoardMember'] },
    async (request: NextRequest, auth, { params }) => {
        if (auth.type !== 'session') {
            return apiError("Unauthorized", 401);
        }

        try {
            const { id: idParam } = await params;
            const id = parseInt(idParam, 10);
            if (Number.isNaN(id)) {
                return apiError("Invalid exception ID", 400);
            }

            const body = await request.json();
            const action = body.action;
            if (action !== 'acknowledge' && action !== 'resolve') {
                return apiError("action must be 'acknowledge' or 'resolve'", 400);
            }

            const conflict = await exceptionConflict(id, auth.user.id);
            if (conflict === 'mirror-unavailable') {
                return apiError("Payment details are unavailable right now; try again shortly", 503);
            }
            if (conflict) {
                return apiError("You cannot act on a payment problem for yourself or your own household — someone outside your household must.", 403);
            }

            const data =
                action === 'acknowledge'
                    ? { status: 'ACKNOWLEDGED' as const }
                    : {
                          status: 'RESOLVED' as const,
                          resolvedById: auth.user.id,
                          resolvedAt: new Date(),
                          resolutionNote: typeof body.note === 'string' ? body.note : null,
                      };

            const { count } = await prisma.paymentException.updateMany({
                // Scope to the still-actionable states so acting twice (or on a
                // resolved row) is a no-op error, not a silent re-write.
                where: { id, status: { in: ['OPEN', 'ACKNOWLEDGED'] } },
                data,
            });

            if (count === 0) {
                return apiError("No open payment exception with that ID", 409);
            }

            await prisma.auditLog.create({
                data: {
                    actorId: auth.user.id,
                    action: "EDIT",
                    tableName: "PaymentException",
                    affectedEntityId: id,
                    newData: data,
                },
            });

            return NextResponse.json({ success: true });
        } catch (error) {
            logger.error("Failed to update payment exception:", error);
            return apiError("Failed to update payment exception", 500);
        }
    }
);

/**
 * Whether the actor is, or shares a household with, anyone the exception is
 * about: its person, its membership process's household or background-check
 * subject, or the order's payer (matched by customer email). Fails closed when
 * the actor has no household or the order's payer can't be read.
 */
async function exceptionConflict(id: number, actorId: number): Promise<boolean | 'mirror-unavailable'> {
    const actorHouseholdId = await resolveActorHouseholdId(prisma, actorId);
    if (actorHouseholdId === null) return true;

    const exception = await prisma.paymentException.findUnique({
        where: { id },
        select: { personId: true, processId: true, shopifyOrderId: true },
    });
    if (!exception) return false; // the update below 409s

    const subjectHouseholds: (number | null | undefined)[] = [];
    if (exception.personId !== null) {
        if (exception.personId === actorId) return true;
        const person = await prisma.person.findUnique({ where: { id: exception.personId }, select: { householdId: true } });
        subjectHouseholds.push(person?.householdId);
    }
    if (exception.processId !== null) {
        const process = await prisma.orgMembershipProcess.findUnique({
            where: { id: exception.processId },
            select: { orgMembership: { select: { householdId: true } }, subjectPerson: { select: { id: true, householdId: true } } },
        });
        if (process?.subjectPerson?.id === actorId) return true;
        subjectHouseholds.push(process?.orgMembership?.householdId, process?.subjectPerson?.householdId);
    }
    if (exception.shopifyOrderId !== null) {
        let orders: MirrorOrder[];
        try {
            orders = await ordersByLegacyIds([exception.shopifyOrderId]);
        } catch (error) {
            logger.error("Failed to read payer for payment exception conflict check:", error);
            return 'mirror-unavailable';
        }
        const payerEmail = orders[0]?.customerEmail;
        if (payerEmail) {
            const payer = await prisma.person.findFirst({
                where: { email: { equals: payerEmail, mode: 'insensitive' } },
                select: { id: true, householdId: true },
            });
            if (payer?.id === actorId) return true;
            subjectHouseholds.push(payer?.householdId);
        }
    }
    return subjectHouseholds.some((h) => sharesHousehold(actorHouseholdId, h));
}
