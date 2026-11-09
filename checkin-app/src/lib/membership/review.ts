import { Prisma, type OrgMembershipProcessStatus } from "@/generated/prisma/client";
import prisma from "@/lib/prisma";
import { ServiceError } from "@checkin/component-kit";
import { REVIEW_ERROR_STATUS } from "@/lib/domainErrorResponse";
import { sendTemplated } from "@/lib/email-templates/send";
import { emailHouseholdLeads } from "@/lib/emailRecipients";
import { logBackendError, logger } from "@/lib/logger";
import { sendCongrats } from "@/lib/membership/payment";
import { notifyBoardCheckRejected, notifyBoardPaymentException } from "@/lib/membership/boardAlerts";
import type { SettleStep } from "@/lib/membership/settleHouseholdBg";
import { config } from "@/lib/config";
import { canonicalizeEmail } from "@/lib/emailNormalize";
import { openPersonBgForNewMember } from "@/lib/membership/personBgTriggers";
import { openPersonAgreementForNewMember } from "@/lib/membership/personAgreementTriggers";
import { personActor, type AuditActor } from "@/lib/auditActor";
import { sharesHousehold } from "@/lib/conflictOfInterest";
import { type DbClient, type TxClient } from "@/lib/db-client";
import { awaitingBgReview, fromWhere, personBgOpen } from "@/lib/membership/lifecycle";
import { lockAndFindDeniedHousehold } from "@/lib/membership/householdStatus";
import { raisePaymentException, recordPaymentException, type PaymentExceptionNotice } from "@/lib/finance/reconcile/exceptions";
import { SIGN_IN_VERIFIED_PERSON } from "@/lib/person/filters";
import { reviewHoldsRejection } from "@/lib/membership/checkStanding";
import { findSelfGrantRefusal, recordSelfGrantRefusal, refuseSelfGrant, SELF_GRANT_REFUSAL_MESSAGE, type GrantSubject, type SelfGrantRefusal } from "@/lib/membership/selfGrantGuard";

// Loaded on use: settleHouseholdBg imports review.ts, and a static import closes that cycle at load.
const settleModule = () => import("@/lib/membership/settleHouseholdBg");

/**
 * Background-check review: a check review (PERSON_BG) is about one person. Two
 * DISTINCT eligible reviewers (isBackgroundCheckReviewer, or the Board) each decide
 * independently; neither may be the person, share a household with them or the
 * household the review was requested for, or share a household with each other.
 *   - 2 APPROVE  -> the person's lastBackgroundCheck is stamped and the review resolves.
 *   - any REJECT -> the review is BLOCKED; it moves on only by a board reset or by
 *                   the rejector changing their answer to approve, and then needs
 *                   two approvals again.
 * A household application is never reviewed itself: after every outcome
 * settleHouseholdBg moves it on its people's standing (docs/rules/membership.md).
 *
 * The system never sees the check itself — only the attestations.
 */

const REQUIRED_APPROVALS = 2;

/**
 * Board members are implicit background-check reviewers (small-org policy):
 * anywhere an explicit reviewer is required — the queue, PII visibility, the
 * attestation, and the reviewer notification — a board member qualifies too.
 * Single source of truth so the API gate, the service, and the UI can't drift.
 */
export function canReviewBackgroundChecks(u: {
    isBackgroundCheckReviewer?: boolean | null;
    isBoardMember?: boolean | null;
}): boolean {
    return Boolean(u.isBackgroundCheckReviewer || u.isBoardMember);
}

export class ReviewError extends ServiceError {
    constructor(
        public readonly code:
            | "not_reviewer"
            | "not_found"
            | "wrong_phase"
            | "same_household_applicant"
            | "same_household_reviewer"
            | "already_attested"
            | "invalid_subject"
            | "invalid_input"
            | "not_undoable"
            | "shopify_unavailable",
        message: string,
    ) {
        super(REVIEW_ERROR_STATUS[code], message, code);
        this.name = "ReviewError";
    }
}

/** A self-grant refused inside a review transaction; `reviewTransaction` records it after the rollback. */
export class SelfGrantRefusedError extends ReviewError {
    constructor(public readonly refusal: SelfGrantRefusal, message: string) {
        super("same_household_applicant", message);
    }
}

/** A review transaction whose self-grant refusal is recorded outside it, so the audit row outlives the rollback. */
export async function reviewTransaction<T>(fn: (tx: TxClient) => Promise<T>): Promise<T> {
    try {
        return await prisma.$transaction(fn);
    } catch (e) {
        if (e instanceof SelfGrantRefusedError) await recordSelfGrantRefusal(prisma, e.refusal);
        throw e;
    }
}

/** Email every background-check reviewer that an application awaits review. */
export async function notifyReviewers(): Promise<void> {
    try {
        const reviewers = await prisma.person.findMany({
            where: { email: { not: null }, OR: [{ isBackgroundCheckReviewer: true }, { isBoardMember: true }] },
            select: { email: true },
        });
        const actionLink = `${config.baseUrl()}/membership-ops/review`;
        await Promise.all(
            reviewers.map((r) =>
                r.email
                    // sendTemplated never rejects (resolves false + logs via logIntegrationError
                    // on failure) — nothing here for a .catch to ever reach.
                    ? sendTemplated("membership.reviewNeeded", r.email, { actionLink })
                    : Promise.resolve(),
            ),
        );
    } catch (e) {
        logger.error("notifyReviewers failed:", e);
    }
}

async function loadReviewer(reviewerId: number) {
    return prisma.person.findUnique({ where: { id: reviewerId }, select: { id: true, householdId: true, isBackgroundCheckReviewer: true, isBoardMember: true } });
}

type ReviewTarget = { orgMembershipId: number | null; subjectPersonId: number | null; requestedForHouseholdId?: number | null };

/**
 * The household a process is about, for the same-household conflict checks: the
 * subject's for a named check review, else the membership's, else the household a
 * consent review was requested for. Null when none resolves.
 */
export async function applicantHousehold(db: DbClient, process: ReviewTarget): Promise<number | null> {
    if (process.subjectPersonId) {
        const p = await db.person.findUnique({ where: { id: process.subjectPersonId }, select: { householdId: true } });
        return p?.householdId ?? null;
    }
    if (process.orgMembershipId) {
        const m = await db.orgMembership.findUnique({ where: { id: process.orgMembershipId }, select: { householdId: true } });
        return m?.householdId ?? null;
    }
    return process.requestedForHouseholdId ?? null;
}

/**
 * Every household a review's decision touches: the applicant household and, for a
 * consent review, the household it was requested for. A reviewer or Board member in
 * any of them is barred, and each is settled after the decision.
 */
export async function reviewHouseholds(db: DbClient, process: ReviewTarget): Promise<number[]> {
    const ids = [await applicantHousehold(db, process), process.requestedForHouseholdId ?? null];
    return [...new Set(ids.filter((id): id is number => id !== null))];
}

/** The adults a consent review may name: the requested household's live leads. */
async function liveHouseholdLeadIds(db: DbClient, householdId: number): Promise<number[]> {
    const leads = await db.person.findMany({ where: { householdId, isHouseholdLead: true }, select: { id: true } });
    return leads.map((l) => l.id);
}

/**
 * Subject ids off a request body, reduced to plausible ids. Junk becomes an empty
 * list rather than a 500, and the service then rejects it as an unnamed decision —
 * the same 400 as sending nothing.
 */
export function subjectIds(raw: unknown): number[] | undefined {
    if (!Array.isArray(raw)) return undefined;
    return raw.filter((v): v is number => Number.isInteger(v) && v > 0);
}

/**
 * IDs of the check reviews this reviewer may currently decide (not about their own
 * household or the one it was requested for, not already decided by them, no
 * household-mate already on it). The route turns these into model rows for the
 * stripper; the notifications endpoint just counts them.
 */
export async function eligibleReviewProcessIds(reviewerId: number): Promise<number[]> {
    const reviewer = await loadReviewer(reviewerId);
    if (!reviewer || !canReviewBackgroundChecks(reviewer)) return [];

    const processes = await prisma.orgMembershipProcess.findMany({
        where: awaitingBgReview.where,
        orderBy: { stageEnteredAt: "asc" },
        select: {
            id: true,
            requestedForHouseholdId: true,
            subjectPerson: { select: { householdId: true } },
            attestations: { select: { reviewerId: true, reviewer: { select: { householdId: true } } } },
        },
    });

    return processes
        .filter((p) => {
            if (sharesHousehold(reviewer.householdId, p.subjectPerson?.householdId ?? null)) return false; // subject's household
            if (sharesHousehold(reviewer.householdId, p.requestedForHouseholdId)) return false; // requested household
            if (p.attestations.some((a) => a.reviewerId === reviewer.id)) return false; // already decided
            if (p.attestations.some((a) => sharesHousehold(reviewer.householdId, a.reviewer.householdId))) return false; // shares household with other reviewer
            return true;
        })
        .map((p) => p.id);
}

/** Check reviews this reviewer has approved that have not cleared yet. */
const attestedByAndUncleared = (reviewerId: number): Prisma.OrgMembershipProcessWhereInput => ({
    ...awaitingBgReview.where,
    attestations: { some: { reviewerId } },
});

/**
 * IDs of check reviews this reviewer already approved that are still waiting on a
 * second reviewer. They have left the reviewer's actionable queue; this lets a board
 * member find them again to reset.
 */
export async function attestedUnclearedProcessIds(reviewerId: number): Promise<number[]> {
    const reviewer = await loadReviewer(reviewerId);
    if (!reviewer || !canReviewBackgroundChecks(reviewer)) return [];
    const rows = await prisma.orgMembershipProcess.findMany({ where: attestedByAndUncleared(reviewerId), select: { id: true } });
    return rows.map((r) => r.id);
}

/** IDs of blocked check reviews whose rejection is this reviewer's and whose person's household is not denied — the ones they may change to an approval. */
export async function ownRejectedProcessIds(reviewerId: number): Promise<number[]> {
    const reviewer = await loadReviewer(reviewerId);
    if (!reviewer || !canReviewBackgroundChecks(reviewer)) return [];
    const rows = await prisma.orgMembershipProcess.findMany({
        where: { kind: "PERSON_BG", status: "BLOCKED", attestations: { some: { reviewerId, result: "REJECT" } } },
        select: {
            id: true,
            subjectPerson: { select: { household: { select: { orgMembership: { select: { status: true } } } } } },
        },
    });
    return rows.filter((p) => p.subjectPerson?.household?.orgMembership?.status !== "DENIED").map((p) => p.id);
}

/**
 * Reviewer-scoped badge counts for the Review tab / nav:
 *   - canActOn: check reviews this reviewer may decide right now (green).
 *   - approvedAwaitingSecond: reviews this reviewer already approved that still
 *     wait on a second reviewer (gray). An awaiting review only ever holds
 *     approvals, so "this reviewer has an attestation on it" == "approved by me".
 */
export async function reviewQueueCounts(reviewerId: number): Promise<{ canActOn: number; approvedAwaitingSecond: number }> {
    const reviewer = await loadReviewer(reviewerId);
    if (!reviewer || !canReviewBackgroundChecks(reviewer)) return { canActOn: 0, approvedAwaitingSecond: 0 };
    const [canActOnIds, approvedAwaitingSecond] = await Promise.all([
        eligibleReviewProcessIds(reviewerId),
        prisma.orgMembershipProcess.count({ where: attestedByAndUncleared(reviewerId) }),
    ]);
    return { canActOn: canActOnIds.length, approvedAwaitingSecond };
}

type AttestInput = { result: "APPROVE" | "REJECT"; isMarkedVolunteerFamily?: boolean; note?: string; subjectPersonIds?: number[] };

/**
 * Record a reviewer's decision on a check review. A rejection blocks the review; the
 * second approval clears its person. Either way the households it touches are then
 * settled on their people's standing (settleHouseholdBg).
 *
 * A review opened by a household's consent has no person yet: its first decision,
 * approve or reject, names the one lead of the requested household whose report the
 * reviewer read (`subjectPersonIds`). A later decision may repeat that person or
 * omit them, never name another.
 *
 * The Volunteer Family tick is written straight onto the requested household; the
 * review never stores it.
 */
export async function attest(reviewerId: number, processId: number, input: AttestInput) {
    const reviewer = await loadReviewer(reviewerId);
    if (!reviewer || !canReviewBackgroundChecks(reviewer)) throw new ReviewError("not_reviewer", "You are not a background-check reviewer.");

    // FOR UPDATE on the review row serializes concurrent decisions on it.
    type AttestOutcome = { status: OrgMembershipProcessStatus; approvals?: number; reopened?: true; rejected?: true; clearance?: ClearanceOutcome; households: number[] };
    const result = await reviewTransaction<AttestOutcome>(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "OrgMembershipProcess" WHERE id = ${processId} FOR UPDATE`;

        const process = await tx.orgMembershipProcess.findUnique({
            where: { id: processId },
            include: { attestations: { include: { reviewer: { select: { householdId: true } } } } },
        });
        if (!process) throw new ReviewError("not_found", "Application not found.");
        if (process.kind !== "PERSON_BG") throw new ReviewError("wrong_phase", "This application is decided by its people's check reviews, not reviewed itself.");
        if (input.result === "APPROVE" && process.status === "BLOCKED" && process.attestations.some((a) => a.reviewerId === reviewerId && a.result === "REJECT")) {
            return switchRejectionToApprove(tx, reviewerId, process, input);
        }
        if (!awaitingBgReview.has({ kind: process.kind, status: process.status, bgConsentAt: !!process.bgConsentAt, bgClearedAt: !!process.bgClearedAt })) {
            throw new ReviewError("wrong_phase", "This background check is not awaiting review.");
        }

        await throwIfOwnReview(tx, reviewerId, process, { attestation: input.result });
        const naming = process.subjectPersonId === null;
        const subjectPersonId = naming ? await namedSubject(tx, process.requestedForHouseholdId, input.subjectPersonIds) : confirmedSubject(process.subjectPersonId!, input.subjectPersonIds);
        const target = { ...process, subjectPersonId };
        if (naming) await throwIfOwnReview(tx, reviewerId, target, { attestation: input.result });
        if (process.attestations.some((a) => a.reviewerId === reviewerId)) throw new ReviewError("already_attested", "You have already reviewed this background check.");
        if (process.attestations.some((a) => sharesHousehold(reviewer.householdId, a.reviewer.householdId))) throw new ReviewError("same_household_reviewer", "Another reviewer from your household has already reviewed this background check.");

        if (naming) await nameSubject(tx, reviewerId, processId, subjectPersonId);
        if (input.isMarkedVolunteerFamily) await markVolunteerFamily(tx, reviewerId, process.requestedForHouseholdId, processId);
        const households = await reviewHouseholds(tx, target);

        await tx.backgroundCheckAttestation.create({
            data: { processId, reviewerId, subjectPersonId, result: input.result, isMarkedVolunteerFamily: false, note: input.note ?? null },
        });

        if (input.result === "REJECT") {
            const { count } = await tx.orgMembershipProcess.updateMany({ where: { id: processId, ...awaitingBgReview.where }, data: { status: "BLOCKED", stageEnteredAt: new Date() } });
            if (!count) throw movedOn();
            await audit(tx, personActor(reviewerId), processId, { status: process.status }, { status: "BLOCKED", reason: "reviewer reject", subjectPersonId, ...(input.note ? { note: input.note } : {}) });
            return { status: "BLOCKED" as const, rejected: true as const, households };
        }

        const approvals = process.attestations.filter((a) => a.result === "APPROVE").length + 1;
        if (approvals < REQUIRED_APPROVALS) return { status: process.status, approvals, households };
        // An earlier approver is re-checked against the person as they stand now: one
        // who moved into the person's household since approving no longer counts.
        const subjectHouseholdId = await applicantHousehold(tx, target);
        const dependent = process.attestations.some((a) => a.result === "APPROVE"
            && (a.reviewerId === subjectPersonId || sharesHousehold(a.reviewer.householdId, subjectHouseholdId)));
        if (dependent) throw new ReviewError("same_household_reviewer", "An earlier approver is now in this person's household, so this review cannot clear. Ask the board to reset it.");
        const clearance = await clearBackgroundCheck(tx, processId, reviewerId, awaitingBgReview);
        return { status: clearance.status, clearance, households };
    });

    // Side effects outside the transaction (a slow/failed send must not roll it back).
    if (result.clearance) await notifyClearanceOutcome(result.clearance);
    if (result.reopened) await notifyReviewers();
    const settled = await settleAfterReview(result.households, { reviewJustCleared: !!result.clearance });
    // One Board email per rejection: settle sends the paid-application one, this covers every other case (PBR-2).
    if (result.rejected && !settled.includes("paidReject")) await notifyBoardCheckRejected(processId);

    return result.approvals !== undefined ? { status: result.status, approvals: result.approvals } : { status: result.status };
}

/**
 * Runs settleHouseholdBg for each household a review outcome touched, returning every
 * step taken. The outcome has committed, so a failure here is logged rather than
 * reported as a failed decision; the next settle (another decision, a reopen, the
 * daily sweep) repeats it.
 */
async function settleAfterReview(householdIds: readonly number[], opts: { reviewJustCleared?: boolean } = {}): Promise<SettleStep[]> {
    const steps: SettleStep[] = [];
    for (const householdId of householdIds) {
        try {
            steps.push(...await (await settleModule()).settleHouseholdBg(householdId, opts));
        } catch (error) {
            logger.error("settle after review failed:", { householdId }, error);
            await logBackendError(error, "settle after review", { householdId });
        }
    }
    return steps;
}

/** The one lead a first decision names, validated against the requested household's live leads. */
async function namedSubject(tx: TxClient, requestedForHouseholdId: number | null, subjectPersonIds: number[] | undefined): Promise<number> {
    if (requestedForHouseholdId === null) throw new ReviewError("wrong_phase", "This background check names nobody and no household asked for it. Ask the board to reset it.");
    const requested = [...new Set(subjectPersonIds ?? [])];
    if (requested.length !== 1) throw new ReviewError("invalid_subject", "Name the one adult whose background check you reviewed.");
    const candidates = new Set(await liveHouseholdLeadIds(tx, requestedForHouseholdId));
    if (!candidates.has(requested[0])) throw new ReviewError("invalid_subject", "That person is not a household lead on this application.");
    return requested[0];
}

/** A later decision on a named review: it may repeat its person or name nobody, never another. */
function confirmedSubject(subject: number, subjectPersonIds: number[] | undefined): number {
    const requested = [...new Set(subjectPersonIds ?? [])];
    if (requested.length && (requested.length !== 1 || requested[0] !== subject)) {
        throw new ReviewError("invalid_subject", "This review is already about a different adult. Ask the board to reset it if that person is wrong.");
    }
    return subject;
}

/**
 * Fixes the review's person at its first decision. The person's row is locked so two
 * reviews can't name them at once. A review of their own that already has decisions,
 * is blocked or was sent back keeps them: the reviewer reviews them there. An empty
 * one is closed in favour of this review (PBR-11).
 */
async function nameSubject(tx: TxClient, reviewerId: number, processId: number, subjectPersonId: number) {
    await tx.$queryRaw`SELECT id FROM "Person" WHERE id = ${subjectPersonId} FOR UPDATE`;
    const own = await tx.orgMembershipProcess.findMany({
        where: { kind: "PERSON_BG", subjectPersonId, id: { not: processId }, ...personBgOpen.where },
        select: { id: true, status: true, _count: { select: { attestations: true } } },
    });
    for (const other of own) {
        if (other.status === "BLOCKED" || other._count.attestations > 0 || await reviewHoldsRejection(tx, other.id)) {
            throw new ReviewError("invalid_subject", `This person already has a background-check review of their own (#${other.id}). Review them there.`);
        }
        await tx.$queryRaw`SELECT id FROM "OrgMembershipProcess" WHERE id = ${other.id} FOR UPDATE`;
        const { count } = await tx.orgMembershipProcess.updateMany({
            where: { id: other.id, ...fromWhere("PENDING_BG_REVIEW"), attestations: { none: {} } },
            data: { status: "ARCHIVED", archivedFromStatus: "PENDING_BG_REVIEW", stageEnteredAt: new Date() },
        });
        if (!count) throw movedOn();
        await audit(tx, personActor(reviewerId), other.id, { status: "PENDING_BG_REVIEW" }, { status: "ARCHIVED", action: "replaced by a check review", replacedByReviewId: processId });
    }
    const { count } = await tx.orgMembershipProcess.updateMany({ where: { id: processId, subjectPersonId: null }, data: { subjectPersonId } });
    if (!count) throw movedOn();
    await audit(tx, personActor(reviewerId), processId, { subjectPersonId: null }, { action: "subject named", subjectPersonId });
}

/**
 * Ruling D: a reviewer's Volunteer Family tick is written on the review's requested
 * household at once, as its own audited change. It only ever sets the status;
 * removing it is a Board edit.
 */
async function markVolunteerFamily(tx: TxClient, reviewerId: number, householdId: number | null, processId: number) {
    if (householdId === null) throw new ReviewError("invalid_input", "This background check was not requested by a household, so it cannot mark a Volunteer Family.");
    const membership = await tx.orgMembership.findUnique({ where: { householdId }, select: { id: true, isVolunteerFamily: true } });
    if (!membership) throw new ReviewError("invalid_input", "The household this check was requested for has no membership to mark.");
    if (membership.isVolunteerFamily) return;
    await throwIfOwnHousehold(tx, reviewerId, { householdId }, { isVolunteerFamily: true });
    await tx.orgMembership.update({ where: { id: membership.id }, data: { isVolunteerFamily: true } });
    await tx.auditLog.create({
        data: {
            ...personActor(reviewerId),
            action: "EDIT",
            tableName: "OrgMembership",
            affectedEntityId: membership.id,
            secondaryAffectedEntity: processId,
            oldData: { isVolunteerFamily: false },
            newData: { isVolunteerFamily: true, via: "background-check review" },
        },
    });
}

/** Refuses a reviewer who is the review's person or in any household its decision touches. */
async function throwIfOwnReview(tx: TxClient, reviewerId: number, process: ReviewTarget, attempted: Prisma.InputJsonObject) {
    const message = "You cannot review a background check for your own household.";
    if (process.subjectPersonId) {
        await throwIfOwnHousehold(tx, reviewerId, { personId: process.subjectPersonId, householdId: await applicantHousehold(tx, process) }, attempted, message);
    }
    for (const householdId of await reviewHouseholds(tx, process)) await throwIfOwnHousehold(tx, reviewerId, { householdId }, attempted, message);
}

/**
 * The rejector of a BLOCKED check review changes their answer to approve. Every
 * attestation goes — their rejection and anyone else's earlier decision, kept only
 * in the audit row — the review returns to waiting, keeping its person, and this
 * approval stands as the first of the two it now needs. Refused on a denied
 * household, as the board reset is. Runs under attest()'s process lock.
 */
async function switchRejectionToApprove(
    tx: TxClient,
    reviewerId: number,
    process: BlockedResetRow & { id: number; orgMembershipId: number | null; subjectPersonId: number | null; requestedForHouseholdId: number | null },
    input: AttestInput,
) {
    const processId = process.id;
    if (process.subjectPersonId === null) throw new ReviewError("wrong_phase", "This rejection names nobody. Ask the board to reset it.");
    const subjectPersonId = confirmedSubject(process.subjectPersonId, input.subjectPersonIds);
    await throwIfOwnReview(tx, reviewerId, process, { attestation: "APPROVE" });
    const households = await reviewHouseholds(tx, process);
    if (await lockAndFindDeniedHousehold(tx, households) !== null) {
        throw new ReviewError("wrong_phase", "This household has been denied membership, so its background-check review cannot be reopened.");
    }
    if (input.isMarkedVolunteerFamily) await markVolunteerFamily(tx, reviewerId, process.requestedForHouseholdId, processId);
    const reviewStatus = blockedResetStatus(process);

    const attestations = await tx.backgroundCheckAttestation.findMany({ where: { processId }, orderBy: { id: "asc" } });
    await tx.backgroundCheckAttestation.deleteMany({ where: { processId } });
    const { count } = await tx.orgMembershipProcess.updateMany({
        where: { id: processId, ...fromWhere("BLOCKED") },
        data: { status: reviewStatus, bgClearedAt: null, stageEnteredAt: new Date() },
    });
    if (!count) throw movedOn();
    await tx.backgroundCheckAttestation.create({
        data: { processId, reviewerId, subjectPersonId, result: "APPROVE", isMarkedVolunteerFamily: false, note: input.note ?? null },
    });
    await audit(tx, personActor(reviewerId), processId, { status: "BLOCKED", attestations }, { status: reviewStatus, action: "rejector changed to approve" });
    return { status: reviewStatus, approvals: 1, reopened: true as const, households };
}

/**
 * A reviewer withdraws their own APPROVE while the review still waits on its
 * second reviewer. The person the review names stays named: only the Board's
 * wrong-person reset clears it. A REJECT is not undoable — it blocked the review,
 * and moving that on is a board reset.
 */
export async function undoOwnApproval(reviewerId: number, processId: number, reason: string) {
    await prisma.$transaction(async (tx) => {
        // Same lock as attest(): a concurrent second approval either clears first (and this refuses) or waits.
        await tx.$queryRaw`SELECT id FROM "OrgMembershipProcess" WHERE id = ${processId} FOR UPDATE`;
        const process = await tx.orgMembershipProcess.findUnique({ where: { id: processId }, include: { attestations: true } });
        if (!process) throw new ReviewError("not_found", "Application not found.");
        const own = process.attestations.find((a) => a.reviewerId === reviewerId);
        if (!own) throw new ReviewError("not_undoable", "You have no attestation on this application to undo.");
        if (own.result !== "APPROVE") throw new ReviewError("not_undoable", "A rejection cannot be undone. Ask the board to reset the review.");
        if (process.bgClearedAt) throw new ReviewError("not_undoable", "This background check has already cleared, so the approval cannot be undone.");
        if (!awaitingBgReview.has({ kind: process.kind, status: process.status, bgConsentAt: !!process.bgConsentAt, bgClearedAt: false })) {
            throw new ReviewError("wrong_phase", "This application is no longer awaiting background-check review.");
        }
        await tx.backgroundCheckAttestation.delete({ where: { id: own.id } });
        await tx.auditLog.create({
            data: {
                ...personActor(reviewerId),
                action: "DELETE",
                tableName: "BackgroundCheckAttestation",
                affectedEntityId: own.id,
                secondaryAffectedEntity: processId,
                oldData: {
                    processId: own.processId,
                    reviewerId: own.reviewerId,
                    subjectPersonId: own.subjectPersonId,
                    result: own.result,
                    note: own.note,
                    isMarkedVolunteerFamily: own.isMarkedVolunteerFamily,
                    createdAt: own.createdAt,
                },
                newData: { reason, action: "reviewer undo" },
            },
        });
    });
}

/**
 * A check review's second approval: stamps its person's lastBackgroundCheck and
 * resolves the review. settleHouseholdBg moves the households after commit. A subject
 * in a DENIED household converges nowhere: nothing is written, and the outcome
 * carries `denied` so the caller raises it to the board after commit.
 * Must run inside a tx holding a FOR UPDATE lock on the process row; `expected` is the
 * state the caller expects the process to still be in, re-checked here.
 */
export async function clearBackgroundCheck(
    tx: TxClient,
    processId: number,
    actorId: number,
    expected: { where: Prisma.OrgMembershipProcessWhereInput },
): Promise<ClearanceOutcome> {
    const process = await tx.orgMembershipProcess.findFirst({
        where: { id: processId, ...expected.where },
        include: { attestations: true },
    });
    if (!process) throw movedOn();
    if (process.kind !== "PERSON_BG") throw new ReviewError("wrong_phase", "Only a check review clears a background check.");
    if (!process.subjectPersonId) throw new ReviewError("wrong_phase", "This background check names nobody, so it cannot clear.");
    const now = new Date();
    const subject = { personId: process.subjectPersonId, householdId: await applicantHousehold(tx, process) };
    await throwIfOwnHousehold(tx, actorId, subject, { lastBackgroundCheck: now.toISOString() });
    if (subject.householdId !== null) {
        const [subjectMembership] = await tx.$queryRaw<{ status: string }[]>`SELECT status FROM "OrgMembership" WHERE "householdId" = ${subject.householdId} FOR UPDATE`;
        if (subjectMembership?.status === "DENIED") {
            return deniedClearance(tx, process.status, subject.householdId, processId);
        }
    }
    await tx.person.update({ where: { id: process.subjectPersonId }, data: { lastBackgroundCheck: now } });
    const { count } = await tx.orgMembershipProcess.updateMany({ where: { id: processId, ...expected.where }, data: { bgClearedAt: now, status: "ACTIVE", stageEnteredAt: now } });
    if (!count) throw movedOn();
    await audit(tx, personActor(actorId), processId, { status: process.status }, { status: "ACTIVE", bgCleared: true, subjectPersonId: process.subjectPersonId });
    return { status: "ACTIVE", activated: false, householdId: null, isInitial: false };
}

/** A clearance reaching a DENIED household. The board item commits with the clearance's transaction, because no sweep finds it later. */
async function deniedClearance(tx: TxClient, status: OrgMembershipProcessStatus, householdId: number, processId: number): Promise<ClearanceOutcome> {
    const notice = await recordPaymentException(tx, "DENIED_HOUSEHOLD_ACTIVITY", { processId, severity: "CRITICAL" });
    return { status, activated: false, householdId: null, isInitial: false, denied: { householdId, processId, notice } };
}

/** An unlocked writer (archive) can still move the row between the locked read and the write. */
function movedOn() {
    return new ReviewError("wrong_phase", "This application changed while it was being reviewed. Reload and try again.");
}

/** Throws a SelfGrantRefusedError when the actor is the subject or shares its household; run it inside `reviewTransaction`. */
async function throwIfOwnHousehold(tx: TxClient, actorId: number, subject: GrantSubject, attempted: Prisma.InputJsonObject, message = SELF_GRANT_REFUSAL_MESSAGE) {
    const refusal = await findSelfGrantRefusal(tx, actorId, subject, { table: "Person", attempted });
    if (refusal) throw new SelfGrantRefusedError(refusal, message);
}

/** What a clearance settled to, for the sends that run after the transaction commits. */
export type ClearanceOutcome = {
    status: OrgMembershipProcessStatus;
    activated: boolean;
    householdId: number | null;
    isInitial: boolean;
    /** Set when the household is DENIED: nothing converged, the board item is written, and `notice` is the email it owes. */
    denied?: { householdId: number; processId: number; notice: PaymentExceptionNotice | null };
    /** Set when the paid order was refunded: held unactivated, and the board is owed an item. */
    refunded?: { processId: number; shopifyOrderId: string };
};

/**
 * Runs a step whose failure must not change what the clearance reports: it has
 * committed, and retrying the attestation is refused, so a throw would only tell the
 * reviewer a saved clearance failed.
 */
async function afterClearanceCommitted(step: string, outcome: ClearanceOutcome, run: () => Promise<unknown>): Promise<void> {
    try {
        await run();
    } catch (error) {
        const context = { householdId: outcome.householdId ?? outcome.denied?.householdId, processId: outcome.denied?.processId ?? outcome.refunded?.processId };
        logger.error(`clearance ${step} failed:`, context, error);
        await logBackendError(error, `clearance ${step}`, context);
    }
}

/**
 * The sends every clearance owes after it commits: the email for a DENIED household's
 * board item, the board item for a refunded order, congrats + the new-member triggers
 * on activation, else the payment-open notice. Never throws. What a failed step leaves
 * behind is picked up later: the daily reconcile raises a refunded order, and the
 * nightly and annual sweeps open what the triggers missed.
 */
export async function notifyClearanceOutcome(outcome: ClearanceOutcome, opts?: { paymentOpenNotice?: (householdId: number) => Promise<void> }) {
    const { denied, refunded, householdId } = outcome;
    if (denied) {
        logger.warn(`[membership] activity on DENIED household ${denied.householdId}: background check cleared`);
        const { notice } = denied;
        if (notice) await afterClearanceCommitted("denied household email", outcome, () => notifyBoardPaymentException(notice.kind, notice.severity, notice.exceptionId));
        return;
    }
    if (refunded) {
        await afterClearanceCommitted("refunded order raise", outcome, () => raisePaymentException("REVERSED_BEFORE_ACTIVATION", { ...refunded, severity: "CRITICAL" }));
        return;
    }
    if (outcome.activated && householdId) {
        await afterClearanceCommitted("congrats email", outcome, () => sendCongrats(householdId, outcome.isInitial));
        // Trigger C: a brand-new (INITIAL) member just activated — open PERSON_BG
        // for any program-attached ≥18 person in the household, and the agreement
        // side, where an adult child signs their own.
        if (outcome.isInitial) {
            await afterClearanceCommitted("person background-check trigger", outcome, () => openPersonBgForNewMember(householdId, new Date()));
            await afterClearanceCommitted("person agreement trigger", outcome, () => openPersonAgreementForNewMember(householdId, new Date()));
        }
    } else if (householdId) {
        // Household process cleared into PENDING_PAYMENT (a PERSON_BG has no
        // household/payment) — tell the family payment is open.
        await afterClearanceCommitted("payment-open notice", outcome, () => (opts?.paymentOpenNotice ?? notifyPaymentOpen)(householdId));
    }
}

/**
 * True if any household-lead email matches any volunteer-designation email, under
 * the shared Gmail/+tag-aware canonicalization. Pure, so the money-path
 * match rule is unit-testable without a DB. DRIVES THE MEMBERSHIP FEE via isVolunteerFamily.
 */
export function matchesVolunteerDesignation(parentEmails: string[], designationEmails: string[]): boolean {
    const parents = new Set(parentEmails.map(canonicalizeEmail));
    if (!parents.size) return false;
    return designationEmails.some((d) => parents.has(canonicalizeEmail(d)));
}

/**
 * Sticky/additive volunteer status: set Membership.isVolunteerFamily = true if ANY
 * reviewer marked the family volunteer-only OR a household parent's sign-in-verified
 * email is pre-designated. Never clears it here. Runs at every PENDING_PAYMENT transition
 * (external advance, fresh-check intake shortcut, fresh-check renewal) so the
 * allowlist drives the membership fee BEFORE the check clears, and again at clearance
 * with the reviewers' volunteer marks.
 * Not a self-grant site: designations are guarded where written, and the
 * reviewer-marked pass runs only behind clearBackgroundCheck's guard.
 */
export async function applyVolunteerFamilyStatus(db: DbClient, orgMembershipId: number, householdId: number, markedByReviewer: boolean) {
    let isVolunteerFamily = markedByReviewer;
    if (!isVolunteerFamily) {
        const parents = await db.person.findMany({ where: { householdId, isHouseholdLead: true, email: { not: null }, ...SIGN_IN_VERIFIED_PERSON }, select: { email: true } });
        const designations = await db.volunteerDesignation.findMany({ select: { email: true } });
        isVolunteerFamily = matchesVolunteerDesignation(parents.map((p) => p.email!), designations.map((d) => d.email));
    }
    if (isVolunteerFamily) {
        await db.orgMembership.update({ where: { id: orgMembershipId }, data: { isVolunteerFamily: true } });
    }
}

/**
 * Board reset of a check review, with a written reason: zero attestations, ready for
 * two new approvals. It reaches a review that is BLOCKED **or** still in progress — an
 * accidental first approval is the same "restart this review". A review that has
 * already CLEARED is out of reach: its stamp and the mail it sent have fanned out.
 * The board never clears a check itself.
 *
 * The person the review names stays named, except on the wrong-person reset
 * (`wrongPerson`), which only a review requested by a household takes: it returns to
 * no person, and the next first decision names again (PBR-12).
 *
 * A household application blocked by a household attestation before cutover is still
 * reset here; one in review is not, because nothing reviews it now.
 */
export async function boardResetReview(processId: number, actorId: number, opts: { reason: string; wrongPerson?: boolean }) {
    const process = await prisma.orgMembershipProcess.findUnique({ where: { id: processId } });
    if (!process) throw new ReviewError("not_found", "Application not found.");
    const isReview = process.kind === "PERSON_BG";
    if (!isReview && (process.status !== "BLOCKED" || await (await settleModule()).blockedByCheckReview(prisma, processId))) {
        throw new ReviewError("wrong_phase", "This application is decided by its people's check reviews. Reset the person's check review instead.");
    }
    if (opts.wrongPerson && (!isReview || process.requestedForHouseholdId === null || process.subjectPersonId === null)) {
        throw new ReviewError("invalid_input", "Only a check review a household asked for, with a person named, can be reset as the wrong person.");
    }

    // Conflict of interest: no actor may reset a review about their own household, or
    // the household it was requested for — else they could wipe their family's failed
    // background check, the very thing attest()'s same-household gate forbids.
    const households = await reviewHouseholds(prisma, process);
    for (const householdId of households) {
        if (await refuseSelfGrant(prisma, actorId, { householdId }, { table: "Person", attempted: { override: "reset" } })) {
            throw new ReviewError("same_household_applicant", "You cannot reset your own household's review — someone outside your household must.");
        }
    }

    const status = await prisma.$transaction(async (tx) => {
        // FOR UPDATE per attest()'s contract: without it a concurrent second
        // attestation could clear the check between the phase test and the delete,
        // leaving a cleared process with no attestations behind it.
        await tx.$queryRaw`SELECT id FROM "OrgMembershipProcess" WHERE id = ${processId} FOR UPDATE`;
        const fresh = await tx.orgMembershipProcess.findUnique({ where: { id: processId }, select: { status: true, kind: true, paidAt: true, bgConsentAt: true, bgClearedAt: true, contractSignedAt: true, subjectPersonId: true } });
        if (!fresh) throw new ReviewError("not_found", "Application not found.");
        if (await lockAndFindDeniedHousehold(tx, households) !== null) {
            throw new ReviewError("wrong_phase", "This household has been denied membership, so its background-check review cannot be reset.");
        }
        const blocked = fresh.status === "BLOCKED";
        if (!blocked && !awaitingBgReview.has({ kind: fresh.kind, status: fresh.status, bgConsentAt: !!fresh.bgConsentAt, bgClearedAt: !!fresh.bgClearedAt })) {
            throw new ReviewError("wrong_phase", "This background-check review is neither blocked nor still in progress.");
        }
        const clearsSubject = !!opts.wrongPerson && fresh.subjectPersonId !== null;
        const reviewStatus = blocked ? blockedResetStatus(fresh) : fresh.status;
        // The deleted attestations, a rejection and its note included, live on only in the audit row.
        const attestations = await tx.backgroundCheckAttestation.findMany({ where: { processId }, orderBy: { id: "asc" } });
        await tx.backgroundCheckAttestation.deleteMany({ where: { processId } });
        const { count } = await tx.orgMembershipProcess.updateMany({
            where: { id: processId, ...(blocked ? fromWhere("BLOCKED") : awaitingBgReview.where) },
            data: { status: reviewStatus, bgClearedAt: null, stageEnteredAt: new Date(), ...(clearsSubject ? { subjectPersonId: null } : {}) },
        });
        if (!count) throw movedOn();
        await audit(
            tx,
            personActor(actorId),
            processId,
            { status: fresh.status, attestations, ...(clearsSubject ? { subjectPersonId: fresh.subjectPersonId } : {}) },
            { status: reviewStatus, action: "board reset", reason: opts.reason, ...(clearsSubject ? { subjectPersonId: null } : {}) },
        );
        return reviewStatus;
    });
    await notifyReviewers();
    await settleAfterReview(households);
    return { status };
}

type BlockedResetRow = {
    kind: string;
    bgConsentAt: Date | null;
    paidAt: Date | null;
    contractSignedAt: Date | null;
};

/**
 * The step a BLOCKED review or application resumes at when its block is lifted. A
 * check review returns to waiting for review. A household application goes back to
 * the external step when consent or the agreement is missing, so it never reaches
 * payment unsigned; otherwise to PENDING_BG_CLEARANCE if paid, else PENDING_PAYMENT.
 */
export function blockedResetStatus(process: BlockedResetRow): OrgMembershipProcessStatus {
    return process.kind === "PERSON_BG" ? "PENDING_BG_REVIEW"
        : !process.bgConsentAt || !process.contractSignedAt ? "PENDING_EXTERNAL_ACTION"
        : process.paidAt ? "PENDING_BG_CLEARANCE"
        : "PENDING_PAYMENT";
}

/**
 * The check cleared but the membership fee isn't paid — the process just (re)entered
 * PENDING_PAYMENT. The status cards/banner promise an email at clearance.
 * Best-effort (send failures log).
 */
/**
 * Payment opened because a check the household already held was recognised, not
 * because anyone reviewed one. The notice above would tell a family a review
 * completed when no reviewer read anything.
 */
export async function notifyPaymentOpenOnExistingCheck(householdId: number) {
    await emailHouseholdLeads(
        householdId,
        "membership.paymentOpenExistingCheck",
        { actionLink: `${config.baseUrl()}/membership` },
        "Payment-open notice failed:",
    );
}

async function notifyPaymentOpen(householdId: number) {
    await emailHouseholdLeads(
        householdId,
        "membership.paymentOpen",
        { actionLink: `${config.baseUrl()}/membership` },
        "Payment-open notice failed:",
    );
}

function audit(db: DbClient, actor: AuditActor, processId: number, oldData: object, newData: object) {
    return db.auditLog.create({
        data: {
            ...actor,
            action: "EDIT",
            tableName: "OrgMembershipProcess",
            affectedEntityId: processId,
            oldData,
            newData,
        },
    });
}
