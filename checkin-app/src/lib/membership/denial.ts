/**
 * What a household's denial does beyond its status, inside the deny's transaction
 * (docs/rules/membership.md, "Activation"):
 *   - trusted-adult access is revoked at once, both directions;
 *   - program ties go to the board's payment-problems queue for removal by hand.
 *     Nothing in that group is removed here.
 *
 * Called only by `setHouseholdStatus`, the one writer of a DENIED status.
 */
import type { TrustedAdultReviewStatus } from "@/generated/prisma/client";
import type { DbClient, TxClient } from "@/lib/db-client";
import type { AuditActor } from "@/lib/auditActor";
import { recordPaymentException, type PaymentExceptionKind } from "@/lib/finance/reconcile/exceptions";
import { notifyBoardPaymentException } from "@/lib/membership/boardAlerts";
import { ENROLLED_PARTICIPANT, LIVE_PERSON } from "@/lib/person/filters";

export const DENIAL_REVOKE_REASON = "household denied";

/** The queue kind every denied-household item uses; a program tie names its program. */
const DENIED_HOUSEHOLD_KIND: PaymentExceptionKind = "DENIED_HOUSEHOLD_ACTIVITY";

/** Review states a denial leaves alone: already revoked, or the board's own refusal. */
const SETTLED_REVIEW: TrustedAdultReviewStatus[] = ["REVOKED", "DENIED"];

export interface DenialOutcome {
    revokedReviewIds: number[];
    /** The board's queue rows this denial opened or reopened. */
    boardItemIds: number[];
}

/** Revokes the household's trusted-adult access and opens its board items. */
export async function applyHouseholdDenial(tx: TxClient, householdId: number, actor: AuditActor): Promise<DenialOutcome> {
    const members = await tx.person.findMany({ where: { householdId, ...LIVE_PERSON }, select: { id: true } });
    const memberIds = members.map((m) => m.id);
    const revokedReviewIds = await revokeTrustedAdults(tx, householdId, memberIds, actor);
    const boardItemIds = await openBoardItems(tx, memberIds);
    return { revokedReviewIds, boardItemIds };
}

/**
 * Revokes every live review on the household's own trusted adults and on every
 * other household's trusted adult who is a member of this one, one audit row each.
 */
async function revokeTrustedAdults(tx: TxClient, householdId: number, memberIds: number[], actor: AuditActor): Promise<number[]> {
    const adults = await tx.trustedAdult.findMany({
        where: {
            OR: [
                { householdId },
                ...(memberIds.length ? [{ trustedAdultPersonId: { in: memberIds } }] : []),
            ],
        },
        select: { id: true },
        orderBy: { id: "asc" },
    });
    const revoked: number[] = [];
    for (const ta of adults) {
        // The same parent-row lock renew, withdraw and decide take, in id order.
        await tx.$queryRaw`SELECT id FROM "TrustedAdult" WHERE id = ${ta.id} FOR UPDATE`;
        const live = await tx.trustedAdultReview.findMany({
            where: { trustedAdultId: ta.id, status: { notIn: SETTLED_REVIEW } },
            select: { id: true, status: true },
            orderBy: { id: "asc" },
        });
        if (live.length === 0) continue;
        await tx.trustedAdultReview.updateMany({ where: { id: { in: live.map((r) => r.id) } }, data: { status: "REVOKED" } });
        for (const r of live) {
            await tx.auditLog.create({
                data: {
                    ...actor,
                    action: "EDIT",
                    tableName: "TrustedAdult",
                    affectedEntityId: ta.id,
                    secondaryAffectedEntity: householdId,
                    oldData: { status: r.status, reviewId: r.id },
                    newData: { status: "REVOKED", reviewId: r.id, reason: DENIAL_REVOKE_REASON, deniedHouseholdId: householdId },
                },
            });
            revoked.push(r.id);
        }
    }
    return revoked;
}

/**
 * One queue row per member and program they are enrolled in (pending or active),
 * volunteer on or lead, under the denied-household kind with the program named.
 * Programs already finished are left out.
 */
async function openBoardItems(tx: TxClient, memberIds: number[]): Promise<number[]> {
    if (memberIds.length === 0) return [];
    const unfinished = { phase: { not: "FINISHED" as const } };
    const enrollments = await tx.programParticipant.findMany({
        where: { personId: { in: memberIds }, person: LIVE_PERSON, program: unfinished, ...ENROLLED_PARTICIPANT },
        select: { personId: true, programId: true },
    });
    const volunteers = await tx.programVolunteer.findMany({
        where: { personId: { in: memberIds }, person: LIVE_PERSON, program: unfinished },
        select: { personId: true, programId: true },
    });
    const programsLed = await tx.program.findMany({ where: { leadMentorId: { in: memberIds }, ...unfinished }, select: { id: true, leadMentorId: true } });
    const instancesLed = await tx.programInstance.findMany({ where: { leadMentorId: { in: memberIds }, ...unfinished }, select: { programId: true, leadMentorId: true } });

    const ties = new Map<string, { personId: number; programId: number }>();
    const tie = (personId: number | null, programId: number) => {
        if (personId !== null) ties.set(`${personId}:${programId}`, { personId, programId });
    };
    for (const e of enrollments) tie(e.personId, e.programId);
    for (const v of volunteers) tie(v.personId, v.programId);
    for (const p of programsLed) tie(p.leadMentorId, p.id);
    for (const i of instancesLed) tie(i.leadMentorId, i.programId);

    const opened: number[] = [];
    for (const { personId, programId } of ties.values()) {
        const notice = await recordPaymentException(tx, DENIED_HOUSEHOLD_KIND, { personId, programId, severity: "CRITICAL" });
        if (notice) opened.push(notice.exceptionId);
    }
    return opened;
}

/**
 * One board email per denial that left the board program ties to remove. Call
 * after the deny commits; the queue rows are already written by then.
 */
export async function notifyBoardOfDenial(db: DbClient, householdId: number): Promise<void> {
    const members = await db.person.findMany({ where: { householdId, ...LIVE_PERSON }, select: { id: true } });
    const row = await db.paymentException.findFirst({
        where: { kind: DENIED_HOUSEHOLD_KIND, programId: { not: null }, status: { not: "RESOLVED" }, personId: { in: members.map((m) => m.id) } },
        orderBy: { id: "desc" },
        select: { id: true },
    });
    if (row) await notifyBoardPaymentException(DENIED_HOUSEHOLD_KIND, "CRITICAL", row.id);
}
