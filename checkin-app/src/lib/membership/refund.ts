import prisma from "@/lib/prisma";
import { ReviewError, applicantHousehold } from "@/lib/membership/review";
import { fromWhere, refundLandsIn } from "@/lib/membership/lifecycle";
import { hasHouseholdConflict } from "@/lib/conflictOfInterest";
import { personActor } from "@/lib/auditActor";

/**
 * Board "Record refund": records a refund already made in Shopify by clearing
 * `paidAt`, on any paid application that never became a membership. It lands in the
 * step `REFUND_LANDS_IN` names; the background check is untouched and a BLOCKED row
 * stays BLOCKED. Any payment-plan request stays ended.
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
    if (!process.paidAt) throw new ReviewError("wrong_phase", "This application has no payment recorded.");
    const to = refundLandsIn(process.status);
    if (!to) throw new ReviewError("wrong_phase", "A refund can only be recorded on a paid application that has not become a membership.");

    await prisma.$transaction(async (tx) => {
        const { count } = await tx.orgMembershipProcess.updateMany({
            where: { id: processId, ...fromWhere(process.status), paidAt: { not: null } },
            data: {
                paidAt: null,
                isPaymentPlanRequested: false,
                ...(to !== process.status && { status: to, stageEnteredAt: new Date() }),
            },
        });
        if (count !== 1) throw new ReviewError("wrong_phase", "This application changed while you were looking at it. Reload and try again.");
        await tx.auditLog.create({
            data: {
                ...personActor(actorId),
                action: "EDIT",
                tableName: "OrgMembershipProcess",
                affectedEntityId: processId,
                oldData: { status: process.status, paidAt: process.paidAt!.toISOString(), shopifyOrderId: process.shopifyOrderId },
                newData: { status: to, paidAt: null, refundRecorded: true, reason },
            },
        });
    });
    return { status: to };
}
