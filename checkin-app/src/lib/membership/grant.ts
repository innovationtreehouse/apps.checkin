import prisma from "@/lib/prisma";
import { Prisma, type OrgMembershipProcess } from "@/generated/prisma/client";
import { certifyPaymentPlan, PaymentError } from "@/lib/membership/payment";
import { IN_FLIGHT_INITIAL, IN_FLIGHT_RENEWAL } from "@/lib/membership/lifecycle";
import type { DbClient } from "@/lib/db-client";
import { ensureHouseholdMembership, raiseDeniedHouseholdActivity } from "@/lib/membership/householdStatus";

/**
 * Board "Grant Membership" for the current year: money only (owner, 2026-10-12).
 *
 * Pays the household's in-flight application through the same certify path a
 * board-recorded payment takes, so the household goes ACTIVE only when that
 * application converges — paid AND background check cleared. It never writes the
 * household's status itself and never skips the check.
 *
 * - An in-flight application at PENDING_PAYMENT is certified paid (with the reason).
 *   That supersedes the family's own checkout: nothing is left payable.
 * - An in-flight application at an earlier step can't be paid yet (the family still
 *   owes details, the signature or the check consent): refused with the step.
 * - No in-flight application: an INITIAL one is opened at INTAKE for the family to
 *   complete, and the board grants again once it reaches payment. An ACTIVE
 *   household is never given a joining application (it renews instead).
 * - DENIED: refused, and raised to the board.
 */
export type GrantResult =
    | { paid: true; process: OrgMembershipProcess }
    | { paid: false; process: OrgMembershipProcess; opened: boolean };

const IN_FLIGHT_WHERE: Prisma.OrgMembershipProcessWhereInput = {
    OR: [
        { kind: "INITIAL", status: { in: [...IN_FLIGHT_INITIAL] } },
        { kind: "RENEWAL", status: { in: [...IN_FLIGHT_RENEWAL] } },
    ],
};

/** Refuse any board grant, current or coming year, on a DENIED household, and raise it to the board. */
export async function refuseGrantIfDenied(householdId: number, actorId: number): Promise<void> {
    const membership = await prisma.orgMembership.findUnique({ where: { householdId }, select: { status: true } });
    if (membership?.status !== "DENIED") return;
    await raiseDeniedHouseholdActivity({ householdId, what: `board grant attempted by person ${actorId}` });
    throw new PaymentError("wrong_phase", "This household is denied. Restore it before granting membership.");
}

export async function grantCurrentYear(
    householdId: number,
    actor: { actorId: number; reason: string },
): Promise<GrantResult> {
    await refuseGrantIfDenied(householdId, actor.actorId);
    const membership = await ensureHouseholdMembership(prisma, householdId);

    const existing = await prisma.orgMembershipProcess.findFirst({
        where: { orgMembershipId: membership.id, ...IN_FLIGHT_WHERE },
        orderBy: { id: "desc" },
    });

    if (existing) {
        if (existing.status === "PENDING_BG_CLEARANCE") {
            throw new PaymentError("wrong_phase", "This application is already paid and is waiting for its background check.");
        }
        // COI is enforced inside certifyPaymentPlan, which also refuses any status but PENDING_PAYMENT.
        if (existing.status !== "PENDING_PAYMENT") {
            throw new PaymentError("wrong_phase", `The household's application is at ${existing.status}; it can be granted once it reaches payment.`);
        }
        await certifyPaymentPlan(existing.id, actor.actorId, { reason: actor.reason });
        await prisma.auditLog.create({
            data: {
                actorId: actor.actorId,
                action: "EDIT",
                tableName: "OrgMembershipProcess",
                affectedEntityId: existing.id,
                secondaryAffectedEntity: householdId,
                newData: { currentYearGrant: true, reason: actor.reason },
            },
        });
        return { paid: true, process: await prisma.orgMembershipProcess.findUniqueOrThrow({ where: { id: existing.id } }) };
    }

    if (membership.status === "ACTIVE") {
        throw new PaymentError("wrong_phase", "This household is already an active member; there is no application to pay.");
    }
    return { paid: false, ...(await openInitial(membership.id, householdId, actor)) };
}

/** Open an INITIAL application at INTAKE, serialized on the membership row like startIntake. */
async function openInitial(
    orgMembershipId: number,
    householdId: number,
    actor: { actorId: number; reason: string },
): Promise<{ process: OrgMembershipProcess; opened: boolean }> {
    const findInFlight = (db: DbClient) =>
        db.orgMembershipProcess.findFirst({ where: { orgMembershipId, kind: "INITIAL", status: { in: [...IN_FLIGHT_INITIAL] } }, orderBy: { id: "desc" } });
    try {
        return await prisma.$transaction(async (tx) => {
            await tx.$queryRaw`SELECT id FROM "OrgMembership" WHERE id = ${orgMembershipId} FOR UPDATE`;
            const raced = await findInFlight(tx);
            if (raced) return { process: raced, opened: false };
            const process = await tx.orgMembershipProcess.create({ data: { orgMembershipId, kind: "INITIAL", status: "INTAKE" } });
            await tx.auditLog.create({
                data: {
                    actorId: actor.actorId,
                    action: "CREATE",
                    tableName: "OrgMembershipProcess",
                    affectedEntityId: process.id,
                    secondaryAffectedEntity: householdId,
                    newData: { orgMembershipId, kind: "INITIAL", status: "INTAKE", openedByGrant: true, reason: actor.reason },
                },
            });
            return { process, opened: true };
        });
    } catch (e) {
        // membership_one_inflight_initial: a concurrent start won; return its row.
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
            const winner = await findInFlight(prisma);
            if (winner) return { process: winner, opened: false };
        }
        throw e;
    }
}
