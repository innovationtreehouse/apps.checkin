import prisma from "@/lib/prisma";
import { ReviewError, applicantHousehold } from "@/lib/membership/review";
import { fromWhere } from "@/lib/membership/lifecycle";
import { hasHouseholdConflict } from "@/lib/conflictOfInterest";
import { personActor } from "@/lib/auditActor";

/**
 * Board "Record refund": records a refund already made in Shopify by clearing
 * `paidAt`. The background check is untouched.
 *   - PENDING_BG_CLEARANCE → PENDING_PAYMENT: the board can then close it, or the
 *     family can pay again.
 *   - BLOCKED stays BLOCKED, so the rejection isn't erased.
 * `shopifyOrderId` is kept: it is what tells the reconciler the refunded order is
 * already accounted for, so it neither re-activates nor re-flags it.
 */
export async function recordRefund(processId: number, actorId: number, reason: string) {
    const process = await prisma.orgMembershipProcess.findUnique({ where: { id: processId } });
    if (!process) throw new ReviewError("not_found", "Application not found.");
    if (await hasHouseholdConflict(prisma, actorId, await applicantHousehold(prisma, process))) {
        throw new ReviewError("same_household_applicant", "You cannot record a refund on your own household's application — someone outside your household must.");
    }
    if (!process.paidAt) throw new ReviewError("wrong_phase", "This application has no payment recorded.");

    let to: "PENDING_PAYMENT" | "BLOCKED";
    if (process.status === "PENDING_BG_CLEARANCE") to = "PENDING_PAYMENT";
    else if (process.status === "BLOCKED") to = "BLOCKED";
    else throw new ReviewError("wrong_phase", "A refund can only be recorded on a paid application that is waiting on its background check or is blocked.");

    await prisma.$transaction(async (tx) => {
        const { count } = await tx.orgMembershipProcess.updateMany({
            where: {
                id: processId,
                ...(to === "PENDING_PAYMENT" ? fromWhere("PENDING_BG_CLEARANCE") : fromWhere("BLOCKED")),
                paidAt: { not: null },
            },
            data: to === "PENDING_PAYMENT"
                ? { status: "PENDING_PAYMENT", paidAt: null, stageEnteredAt: new Date() }
                : { paidAt: null },
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
