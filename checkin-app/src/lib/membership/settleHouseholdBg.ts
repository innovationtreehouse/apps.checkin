import type { OrgMembershipProcessStatus, Prisma } from "@/generated/prisma/client";
import prisma from "@/lib/prisma";
import type { DbClient, TxClient } from "@/lib/db-client";
import { systemActor } from "@/lib/auditActor";
import { logBackendError } from "@/lib/logger";
import { isOrderReversed } from "@/lib/finance/reconcile/exceptions";
import { recordUnreportedReversalOnProcess } from "@/lib/finance/reconcile/liveOrder";
import { notifyBoardPaidReject } from "@/lib/membership/boardAlerts";
import { householdCheckStandings, householdQualifies, jsonField, liveBgThreshold, reviewHoldsRejection } from "@/lib/membership/checkStanding";
import { advanceExternalIfComplete } from "@/lib/membership/external";
import { lockAndFindDeniedHousehold, setHouseholdStatus } from "@/lib/membership/householdStatus";
import { SETTLE_BLOCKABLE_STATUSES, fromWhere, openProcess, personBgOpen, type ProcessStatus } from "@/lib/membership/lifecycle";
import {
    applyVolunteerFamilyStatus,
    blockedResetStatus,
    notifyClearanceOutcome,
    notifyPaymentOpenOnExistingCheck,
    notifyReviewers,
    type ClearanceOutcome,
} from "@/lib/membership/review";

/**
 * Moves a household's open application to match its people's check standing
 * (docs/in-design/person-based-bg-review.md §3.2):
 *
 * - someone in the household has a BLOCKED check review → the application is
 *   BLOCKED, its audit row naming the review and the step it was blocked from;
 * - every review that blocked it is no longer BLOCKED (reset or changed to approve)
 *   and nobody in the household holds one → it resumes at the step it was blocked
 *   from (`resumeStatus`);
 * - the household qualifies and the application is waiting on its check → its
 *   check is stamped cleared and it converges on payment;
 * - a lead is cleared and only a review naming nobody holds the household → that
 *   review is closed as unneeded and the application clears;
 * - otherwise, consent is recorded, no lead is cleared or under review, nobody is
 *   disputed and no review is open for the household → a check review with no person
 *   is opened for it (`openRequestedReview`).
 *
 * A sent-back review keeps its person DISPUTED, which holds the clearance but does
 * not block: blocking on it would undo the resume a reset exists to give. A denied
 * household's application is never moved, and neither is one blocked by anything
 * but this function. The departed person's rejection keeps the application blocked
 * (§3.4): its review id stays in the audit rows this function reads back.
 *
 * `reviewJustCleared` picks the payment-open email: a review completed, or a check
 * the household already held was recognised.
 */
export async function settleHouseholdBg(householdId: number, opts: { reviewJustCleared?: boolean } = {}): Promise<SettleStep[]> {
    const app = await prisma.orgMembershipProcess.findFirst({
        where: { orgMembership: { householdId }, kind: { in: ["INITIAL", "RENEWAL"] }, ...openProcess.where },
        orderBy: { id: "desc" },
        select: { id: true, status: true },
    });
    if (!app) return [];
    if (CONVERGES.includes(app.status)) await recordUnreportedReversalOnProcess(app.id);
    const threshold = await liveBgThreshold();

    const result = await prisma.$transaction((tx) => settleInTx(tx, app.id, householdId, threshold));

    if (result.steps.includes("opened")) await notifyReviewers();
    if (result.paidReject) await notifyBoardPaidReject(app.id);
    if (result.advanceExternal) await advanceExternalIfComplete(app.id);
    if (result.clearance) {
        await notifyClearanceOutcome(result.clearance, opts.reviewJustCleared ? undefined : { paymentOpenNotice: notifyPaymentOpenOnExistingCheck });
    }
    return result.steps;
}

/**
 * Settles every household whose open application has consent and is waiting on its
 * check, so one with no check review open gets one. Each household is settled on its
 * own; a failure is logged and the rest carry on.
 */
export async function settleApplicationsAwaitingCheck(): Promise<{ households: number; opened: number; failed: number }> {
    const apps = await prisma.orgMembershipProcess.findMany({
        where: { kind: { in: ["INITIAL", "RENEWAL"] }, bgConsentAt: { not: null }, bgClearedAt: null, ...openProcess.where },
        select: { orgMembership: { select: { householdId: true } } },
    });
    const households = [...new Set(apps.flatMap((a) => (a.orgMembership ? [a.orgMembership.householdId] : [])))];
    let opened = 0;
    let failed = 0;
    for (const householdId of households) {
        try {
            if ((await settleHouseholdBg(householdId)).includes("opened")) opened++;
        } catch (error) {
            failed++;
            await logBackendError(error, "household background-check settle sweep", { householdId });
        }
    }
    return { households: households.length, opened, failed };
}

export type SettleStep = "denied" | "blocked" | "resumed" | "cleared" | "opened";

type Settled = { steps: SettleStep[]; paidReject?: boolean; advanceExternal?: boolean; clearance?: ClearanceOutcome };

const ACTOR = systemActor("system:membership-bg-settle");
const BLOCK_REASON = "check review rejected";

const BLOCKABLE: readonly ProcessStatus[] = SETTLE_BLOCKABLE_STATUSES;
/** Steps before the review and payment track: a lifted block returns to them as they were. */
const RETURNS_AS_WAS: readonly ProcessStatus[] = ["INTAKE", "PENDING_RENEWAL", "PENDING_EXTERNAL_ACTION"];
/** Waiting steps where only a stamp is owed; the step's own event moves the status on. */
const STAMPS: readonly ProcessStatus[] = ["PENDING_EXTERNAL_ACTION", "PENDING_PAYMENT"];
/** Held steps that nothing but a clearance moves: they converge on payment here. */
const CONVERGES: readonly ProcessStatus[] = ["PENDING_BG_REVIEW", "PENDING_BG_CLEARANCE"];

async function settleInTx(tx: TxClient, processId: number, householdId: number, threshold: Date | null): Promise<Settled> {
    // Process, then household: the order clearBackgroundCheck locks in.
    await tx.$queryRaw`SELECT id FROM "OrgMembershipProcess" WHERE id = ${processId} FOR UPDATE`;
    if (await lockAndFindDeniedHousehold(tx, [householdId]) !== null) return { steps: ["denied"] };
    const process = await tx.orgMembershipProcess.findUnique({
        where: { id: processId },
        select: { id: true, kind: true, status: true, orgMembershipId: true, paidAt: true, bgConsentAt: true, bgClearedAt: true, contractSignedAt: true, shopifyOrderId: true },
    });
    if (!process?.orgMembershipId) return { steps: [] };
    const orgMembershipId = process.orgMembershipId;

    const standings = await householdCheckStandings(tx, householdId, threshold);
    const blockingNow = standings.members.flatMap((m) => m.disputing.filter((r) => r.status === "BLOCKED").map((r) => r.id));
    const steps: SettleStep[] = [];
    let status: OrgMembershipProcessStatus = process.status;
    let cleared = !!process.bgClearedAt;

    if (status === "BLOCKED") {
        const block = await recordedBlock(tx, processId);
        if (block === null) return { steps };
        const recorded = block.reviewIds;
        const unrecorded = blockingNow.filter((id) => !recorded.includes(id));
        if (unrecorded.length) await audit(tx, processId, householdId, { status }, { action: BLOCK_REASON, blockingReviewIds: unrecorded });
        if (unrecorded.length || await tx.orgMembershipProcess.count({ where: { id: { in: recorded }, status: "BLOCKED" } })) return { steps };
        const to = resumeStatus(block.from, process);
        const { count } = await tx.orgMembershipProcess.updateMany({ where: { id: processId, ...fromWhere("BLOCKED") }, data: { status: to, bgClearedAt: null, stageEnteredAt: new Date() } });
        if (!count) return { steps };
        await audit(tx, processId, householdId, { status }, { status: to, action: "check review no longer rejected", blockingReviewIds: recorded });
        status = to;
        cleared = false;
        steps.push("resumed");
    } else if (blockingNow.length) {
        if (!BLOCKABLE.includes(status)) return { steps };
        const { count } = await tx.orgMembershipProcess.updateMany({
            where: { id: processId, ...fromWhere(status) },
            data: { status: "BLOCKED", stageEnteredAt: new Date(), isPaymentPlanRequested: false },
        });
        if (!count) return { steps };
        await audit(tx, processId, householdId, { status }, { status: "BLOCKED", reason: BLOCK_REASON, blockingReviewIds: blockingNow });
        return { steps: ["blocked"], paidReject: !!process.paidAt };
    }

    if (cleared) return { steps };
    if (!householdQualifies(standings)) {
        const leadCleared = standings.members.some((m) => m.isHouseholdLead && m.standing === "CLEARED");
        const disputed = standings.members.some((m) => m.standing === "DISPUTED");
        if (leadCleared && !disputed) {
            // Only a review naming nobody holds it, and a cleared lead has made that review unneeded.
            if (!(await closeUnneededRequestedReviews(tx, householdId, processId))) return { steps };
        } else {
            // A new review helps only a household with no cleared lead and no lead already under review; it cannot lift a dispute.
            if (disputed || leadCleared || standings.members.some((m) => m.isHouseholdLead && m.standing === "PENDING")) return { steps };
            return (await openRequestedReview(tx, { ...process, status }, householdId)) ? { steps: [...steps, "opened"] } : { steps };
        }
    }
    const now = new Date();

    if (STAMPS.includes(status)) {
        const { count } = await tx.orgMembershipProcess.updateMany({ where: { id: processId, bgClearedAt: null, ...fromWhere(status) }, data: { bgClearedAt: now } });
        if (!count) return { steps };
        // Reviewers' Volunteer Family ticks are written when they are made; only the designation allowlist is applied here.
        await applyVolunteerFamilyStatus(tx, orgMembershipId, householdId, false);
        await audit(tx, processId, householdId, { status }, { bgCleared: true, reason: "household qualifies on its people's checks" });
        return { steps: [...steps, "cleared"], advanceExternal: status === "PENDING_EXTERNAL_ACTION" };
    }
    if (!CONVERGES.includes(status)) return { steps };

    const paid = !!process.paidAt;
    const refunded = paid && !!process.shopifyOrderId && (await isOrderReversed(tx, process.shopifyOrderId));
    const to: OrgMembershipProcessStatus = refunded ? "PENDING_BG_CLEARANCE" : paid ? "ACTIVE" : "PENDING_PAYMENT";
    const { count } = await tx.orgMembershipProcess.updateMany({
        where: { id: processId, bgClearedAt: null, ...fromWhere(status) },
        data: { bgClearedAt: now, status: to, stageEnteredAt: now },
    });
    if (!count) return { steps };
    if (to === "ACTIVE") {
        await setHouseholdStatus(tx, orgMembershipId, { from: ["NONE", "REVOKED", "ACTIVE"], to: "ACTIVE", actor: ACTOR, reason: "background check settled on a paid application" });
    }
    await applyVolunteerFamilyStatus(tx, orgMembershipId, householdId, false);
    await audit(tx, processId, householdId, { status }, { status: to, bgCleared: true, reason: "household qualifies on its people's checks", ...(refunded ? { refundedOrder: true } : {}) });
    const clearance: ClearanceOutcome = refunded
        ? { status: to, activated: false, householdId: null, isInitial: false, refunded: { processId, shopifyOrderId: process.shopifyOrderId! } }
        : { status: to, activated: paid, householdId, isInitial: process.kind === "INITIAL" };
    return { steps: [...steps, "cleared"], clearance };
}

/**
 * The check reviews recorded as blocking this application since it last entered
 * BLOCKED and the step it was blocked from, or null when it was blocked by something
 * other than this function (a household attestation), which this never moves.
 */
async function recordedBlock(tx: DbClient, processId: number): Promise<{ reviewIds: number[]; from: Prisma.JsonValue | undefined } | null> {
    const rows = await tx.auditLog.findMany({
        where: { tableName: "OrgMembershipProcess", affectedEntityId: processId },
        orderBy: { id: "desc" },
        select: { oldData: true, newData: true },
    });
    const ids: number[] = [];
    for (const row of rows) {
        const recorded = jsonField(row.newData, "blockingReviewIds");
        if (Array.isArray(recorded)) ids.push(...recorded.filter((v): v is number => typeof v === "number"));
        if (jsonField(row.newData, "status") === "BLOCKED" && jsonField(row.oldData, "status") !== "BLOCKED") {
            return jsonField(row.newData, "reason") === BLOCK_REASON ? { reviewIds: ids, from: jsonField(row.oldData, "status") } : null;
        }
    }
    return null;
}

/** Whether a household application is BLOCKED by a person's check review, which only that review's outcome lifts. */
export async function blockedByCheckReview(db: DbClient, processId: number): Promise<boolean> {
    return (await recordedBlock(db, processId)) !== null;
}

/**
 * Where a lifted block returns the application: a step before review and payment as
 * it was; a review or payment step by `blockedResetStatus`, which sends it back to
 * the external step when consent or the agreement is missing.
 */
function resumeStatus(from: Prisma.JsonValue | undefined, process: Parameters<typeof blockedResetStatus>[0]): OrgMembershipProcessStatus {
    const step = RETURNS_AS_WAS.find((s) => s === from);
    return step ?? blockedResetStatus(process);
}

/**
 * Closes the open reviews requested for the household that still name nobody, once a
 * lead has cleared without them. Returns false, closing nothing, when one of them
 * carries a rejection a wrong-person reset left on it: that needs a decision first.
 */
async function closeUnneededRequestedReviews(tx: TxClient, householdId: number, applicationId: number): Promise<boolean> {
    const unnamed = await tx.orgMembershipProcess.findMany({
        where: { kind: "PERSON_BG", requestedForHouseholdId: householdId, subjectPersonId: null, ...personBgOpen.where },
        select: { id: true },
        orderBy: { id: "asc" },
    });
    for (const { id } of unnamed) {
        await tx.$queryRaw`SELECT id FROM "OrgMembershipProcess" WHERE id = ${id} FOR UPDATE`;
        if (await reviewHoldsRejection(tx, id)) return false;
    }
    for (const { id } of unnamed) {
        const { count } = await tx.orgMembershipProcess.updateMany({
            where: { id, subjectPersonId: null, ...fromWhere("PENDING_BG_REVIEW") },
            data: { status: "ARCHIVED", archivedFromStatus: "PENDING_BG_REVIEW", stageEnteredAt: new Date() },
        });
        if (!count) return false;
        await audit(tx, id, householdId, { status: "PENDING_BG_REVIEW" }, { status: "ARCHIVED", action: "closed: a lead cleared without it", applicationId });
    }
    return true;
}

/**
 * Opens a check review with no person for the household, when the application has
 * consent, is waiting on its check and no open review requested for the household
 * names nobody or someone still in it. Runs under the application's lock, so two
 * settles never open two. The first reviewer names the person.
 */
async function openRequestedReview(tx: TxClient, app: { id: number; status: OrgMembershipProcessStatus; bgConsentAt: Date | null }, householdId: number): Promise<boolean> {
    if (!app.bgConsentAt || app.status === "BLOCKED") return false;
    const open = await tx.orgMembershipProcess.count({
        where: {
            kind: "PERSON_BG",
            requestedForHouseholdId: householdId,
            ...personBgOpen.where,
            OR: [{ subjectPersonId: null }, { subjectPerson: { householdId } }],
        },
    });
    if (open) return false;
    const now = new Date();
    const review = await tx.orgMembershipProcess.create({
        data: { kind: "PERSON_BG", status: "PENDING_BG_REVIEW", requestedForHouseholdId: householdId, bgConsentAt: now, stageEnteredAt: now },
    });
    await tx.auditLog.create({
        data: {
            ...ACTOR,
            action: "CREATE",
            tableName: "OrgMembershipProcess",
            affectedEntityId: review.id,
            secondaryAffectedEntity: householdId,
            newData: { kind: "PERSON_BG", status: "PENDING_BG_REVIEW", requestedForHouseholdId: householdId, subjectPersonId: null, bgConsentAt: true, requestedByApplicationId: app.id },
        },
    });
    return true;
}

function audit(tx: TxClient, processId: number, householdId: number, oldData: Prisma.InputJsonObject, newData: Prisma.InputJsonObject) {
    return tx.auditLog.create({
        data: { ...ACTOR, action: "EDIT", tableName: "OrgMembershipProcess", affectedEntityId: processId, secondaryAffectedEntity: householdId, oldData, newData },
    });
}
