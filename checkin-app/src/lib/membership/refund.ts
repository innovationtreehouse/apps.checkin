import prisma from "@/lib/prisma";
import type { OrgMembershipProcess } from "@/generated/prisma/client";
import { ReviewError, applicantHousehold } from "@/lib/membership/review";
import { DENY_CLOSE_REASON, fromWhere, refundLandsIn } from "@/lib/membership/lifecycle";
import { hasHouseholdConflict } from "@/lib/conflictOfInterest";
import { personActor, systemActor, type AuditActor } from "@/lib/auditActor";

/**
 * Board "Record refund": records a refund already made in Shopify by clearing
 * `paidAt`, on any paid application that never became a membership. It lands in the
 * step `REFUND_LANDS_IN` names; the background check is untouched and a BLOCKED row
 * stays BLOCKED. On a DENIED household the application closes instead, from that
 * step, as the denial closed its unpaid ones. Any payment-plan request stays ended.
 * `shopifyOrderId` is kept, and the audit row records it: the reconciler reads that
 * row to know the refunded order is accounted for, so it neither re-activates nor
 * re-flags it after a re-payment overwrites the column.
 */
export async function recordRefund(processId: number, actorId: number, reason: string) {
    const process = await prisma.orgMembershipProcess.findUnique({ where: { id: processId } });
    if (!process) throw new ReviewError("not_found", "Application not found.");
    if (await hasHouseholdConflict(prisma, actorId, await applicantHousehold(prisma, process))) {
        throw new ReviewError("same_household_applicant", "You cannot record a refund on your own household's application — someone outside your household must.");
    }
    return applyRefund(process, personActor(actorId), reason);
}

/**
 * A full store refund on a DENIED household's paid application records itself, as
 * "Record refund" would; the caller has checked the refund is full. Returns true
 * when it recorded one; false when the order is
 * not this application's payment, the household is not DENIED, or nothing is left
 * to refund.
 */
export async function recordDeniedStoreRefund(processId: number, shopifyOrderId: string): Promise<boolean> {
    const process = await prisma.orgMembershipProcess.findUnique({ where: { id: processId }, include: { orgMembership: { select: { status: true } } } });
    if (!process || process.orgMembership?.status !== "DENIED") return false;
    if (process.shopifyOrderId !== shopifyOrderId || !process.paidAt || !refundLandsIn(process.status)) return false;
    try {
        await applyRefund(process, systemActor("webhook:shopify-refund"), `Store refund on order ${shopifyOrderId}`);
        return true;
    } catch (e: unknown) {
        // Another writer cleared the payment first.
        if (e instanceof ReviewError && e.code === "wrong_phase") return false;
        throw e;
    }
}

async function applyRefund(process: OrgMembershipProcess, actor: AuditActor, reason: string) {
    if (!process.paidAt) throw new ReviewError("wrong_phase", "This application has no payment recorded.");
    const to = refundLandsIn(process.status);
    if (!to) throw new ReviewError("wrong_phase", "A refund can only be recorded on a paid application that has not become a membership.");

    return prisma.$transaction(async (tx) => {
        // The membership row before the application: the order lib/lockOrder.ts states.
        const [membership] = process.orgMembershipId === null
            ? []
            : await tx.$queryRaw<{ status: string }[]>`SELECT status FROM "OrgMembership" WHERE id = ${process.orgMembershipId} FOR UPDATE`;
        const closes = membership?.status === "DENIED";
        const landsIn = closes ? "ARCHIVED" as const : to;
        const { count } = await tx.orgMembershipProcess.updateMany({
            where: { id: process.id, ...fromWhere(process.status), paidAt: { not: null } },
            data: {
                paidAt: null,
                isPaymentPlanRequested: false,
                ...(closes
                    ? { status: "ARCHIVED", archivedFromStatus: to, stageEnteredAt: new Date() }
                    : to !== process.status && { status: to, stageEnteredAt: new Date() }),
            },
        });
        if (count !== 1) throw new ReviewError("wrong_phase", "This application changed while you were looking at it. Reload and try again.");
        await tx.auditLog.create({
            data: {
                ...actor,
                action: "EDIT",
                tableName: "OrgMembershipProcess",
                affectedEntityId: process.id,
                oldData: { status: process.status, paidAt: process.paidAt!.toISOString(), shopifyOrderId: process.shopifyOrderId },
                newData: { status: landsIn, paidAt: null, refundRecorded: true, reason, ...(closes ? { closeReason: DENY_CLOSE_REASON } : {}) },
            },
        });
        return { status: landsIn };
    });
}
