/**
 * What a household's denial does beyond its status, inside the deny's transaction
 * (docs/rules/membership.md, "Activation"):
 *   - trusted-adult access is revoked at once, both directions;
 *   - program ties and mailing lists go to the board's payment-problems queue for
 *     removal by hand. Nothing in that group is removed here.
 *
 * Called only by `setHouseholdStatus`, the one writer of a DENIED status.
 */
import type { TrustedAdultReviewStatus } from "@/generated/prisma/client";
import type { DbClient, TxClient } from "@/lib/db-client";
import type { AuditActor } from "@/lib/auditActor";
import { recordPaymentException, type PaymentExceptionKind } from "@/lib/finance/reconcile/exceptions";
import { notifyBoardPaymentException } from "@/lib/membership/boardAlerts";
import { LIVE_PERSON } from "@/lib/person/filters";

export const DENIAL_REVOKE_REASON = "household denied";

/** Review states a denial leaves alone: already revoked, or the board's own refusal. */
const SETTLED_REVIEW: TrustedAdultReviewStatus[] = ["REVOKED", "DENIED"];

export interface DenialOutcome {
    revokedReviewIds: number[];
    /** The board's queue rows this denial opened or reopened. */
    boardItemIds: number[];
}

/** Revokes the household's trusted-adult access and opens its board items. */
export async function applyHouseholdDenial(tx: TxClient, householdId: number, actor: AuditActor): Promise<DenialOutcome> {
    const members = await tx.person.findMany({ where: { householdId }, select: { id: true } });
    const memberIds = members.map((m) => m.id);
    const revokedReviewIds = await revokeTrustedAdults(tx, householdId, memberIds, actor);
    const boardItemIds = await openBoardItems(tx, householdId, memberIds);
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

type BoardItem = { kind: PaymentExceptionKind; personId: number | null; programId: number | null };

/**
 * One queue row per enrollment, per program role, and one for the household's
 * mailing lists. Programs already finished are left out.
 */
async function openBoardItems(tx: TxClient, householdId: number, memberIds: number[]): Promise<number[]> {
    const items: BoardItem[] = [];
    if (memberIds.length) {
        const unfinished = { phase: { not: "FINISHED" as const } };
        const enrollments = await tx.programParticipant.findMany({
            where: { personId: { in: memberIds }, status: { in: ["PENDING", "ACTIVE"] }, program: unfinished },
            select: { personId: true, programId: true },
        });
        const volunteers = await tx.programVolunteer.findMany({ where: { personId: { in: memberIds }, program: unfinished }, select: { personId: true, programId: true } });
        const programsLed = await tx.program.findMany({ where: { leadMentorId: { in: memberIds }, ...unfinished }, select: { id: true, leadMentorId: true } });
        const instancesLed = await tx.programInstance.findMany({ where: { leadMentorId: { in: memberIds }, ...unfinished }, select: { programId: true, leadMentorId: true } });
        for (const e of enrollments) items.push({ kind: "DENIED_HOUSEHOLD_ENROLLMENT", personId: e.personId, programId: e.programId });
        const roles = new Set<string>();
        const role = (personId: number | null, programId: number) => {
            const key = `${personId}:${programId}`;
            if (roles.has(key)) return;
            roles.add(key);
            items.push({ kind: "DENIED_HOUSEHOLD_PROGRAM_ROLE", personId, programId });
        };
        for (const v of volunteers) role(v.personId, v.programId);
        for (const p of programsLed) role(p.leadMentorId, p.id);
        for (const i of instancesLed) role(i.leadMentorId, i.programId);
    }
    // A household-wide row with no person would dedupe against every other household's.
    const anchor = await anchorPerson(tx, householdId);
    if (anchor !== null) items.push({ kind: "DENIED_HOUSEHOLD_MAILING_LISTS", personId: anchor, programId: null });

    const opened: number[] = [];
    for (const item of items) {
        const notice = await recordPaymentException(tx, item.kind, { personId: item.personId, programId: item.programId, severity: "CRITICAL" });
        if (notice) opened.push(notice.exceptionId);
    }
    return opened;
}

/** The household member a household-wide row is filed under: a live lead first, then any member. */
async function anchorPerson(tx: TxClient, householdId: number): Promise<number | null> {
    const order = [{ isHouseholdLead: "desc" as const }, { id: "asc" as const }];
    const live = await tx.person.findFirst({ where: { householdId, ...LIVE_PERSON }, orderBy: order, select: { id: true } });
    if (live) return live.id;
    const any = await tx.person.findFirst({ where: { householdId }, orderBy: order, select: { id: true } });
    return any?.id ?? null;
}

/**
 * One board email per denial, pointing at the household's mailing-list row. Call
 * after the deny commits; the queue rows are already written by then.
 */
export async function notifyBoardOfDenial(db: DbClient, householdId: number): Promise<void> {
    const members = await db.person.findMany({ where: { householdId }, select: { id: true } });
    const row = await db.paymentException.findFirst({
        where: { kind: "DENIED_HOUSEHOLD_MAILING_LISTS", status: { not: "RESOLVED" }, personId: { in: members.map((m) => m.id) } },
        orderBy: { id: "desc" },
        select: { id: true },
    });
    if (row) await notifyBoardPaymentException("DENIED_HOUSEHOLD_MAILING_LISTS", "CRITICAL", row.id);
}
