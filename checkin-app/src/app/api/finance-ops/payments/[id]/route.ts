import { NextRequest, NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import prisma from "@/lib/prisma";
import { withAuth } from "@/lib/auth";
import { apiError } from "@/lib/api-response";
import type { Prisma } from "@/generated/prisma/client";
import { findSelfGrantRefusal, recordSelfGrantRefusal, type GrantSubject } from "@/lib/membership/selfGrantGuard";
import { orderAttr, ordersByLegacyIds, type MirrorOrder } from "@/lib/shopifyRead/client";
import { walkMergeChain } from "@/lib/person/mergeChain";

/**
 * PATCH /api/finance-ops/payments/[id] — the board acknowledges or resolves one
 * reconciler-detected payment problem.
 *   acknowledge → status ACKNOWLEDGED (seen, not yet cleared).
 *   resolve     → status RESOLVED, stamped with who/when + a note.
 * Only a real session may act (mirrors the payment-plans route), never on their
 * own household's problem; every change is audit-logged.
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

            const conflict = await exceptionConflict(id, auth.user.id, { action });
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
 * subject, or the order's payer (customer email). Uses the shared self-grant
 * guard, so a refusal is audited and an actor with no household is refused.
 * Fails closed when the order's payer can't be read.
 */
async function exceptionConflict(id: number, actorId: number, attempted: Prisma.InputJsonObject): Promise<boolean | 'mirror-unavailable'> {
    const exception = await prisma.paymentException.findUnique({
        where: { id },
        select: { personId: true, processId: true, shopifyOrderId: true },
    });
    if (!exception) return false; // the update below 409s

    const subjects: GrantSubject[] = [];
    const personIds: (number | null)[] = [exception.personId];
    if (exception.processId !== null) {
        const process = await prisma.orgMembershipProcess.findUnique({
            where: { id: exception.processId },
            select: { orgMembership: { select: { householdId: true } }, subjectPersonId: true },
        });
        if (process?.orgMembership) subjects.push({ householdId: process.orgMembership.householdId });
        personIds.push(process?.subjectPersonId ?? null);
    }
    if (exception.shopifyOrderId !== null) {
        let orders: MirrorOrder[];
        try {
            orders = await ordersByLegacyIds([exception.shopifyOrderId]);
        } catch (error) {
            logger.error("Failed to read payer for payment exception conflict check:", error);
            return 'mirror-unavailable';
        }
        const order = orders[0];
        if (order?.customerEmail) subjects.push({ email: order.customerEmail });
        // A program exception records one person; the order may name several children.
        if (order) personIds.push(...orderAccountIds(order));
    }
    for (const personId of new Set(personIds)) {
        if (personId === null) continue;
        subjects.push(...(await mergeChainSubjects(personId)));
    }

    const attempt = { table: "PaymentException" as const, attempted };
    for (const subject of subjects) {
        const refusal = await findSelfGrantRefusal(prisma, actorId, subject, attempt);
        if (refusal) {
            await recordSelfGrantRefusal(prisma, refusal);
            return true;
        }
    }
    return false;
}

function orderAccountIds(order: MirrorOrder): number[] {
    const raw = orderAttr(order, "CheckMeIn_Account_ID") ?? "";
    return raw.split(",").map((s) => parseInt(s.trim(), 10)).filter((n) => !isNaN(n));
}

/** The person plus every record it was merged into, so a merged-away id still resolves to its survivor's household. */
async function mergeChainSubjects(personId: number): Promise<GrantSubject[]> {
    const { chain } = await walkMergeChain(personId);
    return chain.map((step) => ({ personId: step.id, householdId: step.person?.householdId ?? null }));
}
