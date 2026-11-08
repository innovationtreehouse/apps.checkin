import type { OrgMembershipProcessStatus, Prisma } from "@/generated/prisma/client";
import prisma from "@/lib/prisma";
import type { TxClient } from "@/lib/db-client";
import { systemActor } from "@/lib/auditActor";
import { isOrderReversed } from "@/lib/finance/reconcile/exceptions";
import { recordUnreportedReversalOnProcess } from "@/lib/finance/reconcile/liveOrder";
import { notifyBoardPaidReject } from "@/lib/membership/boardAlerts";
import { householdCheckStandings, householdQualifies, liveBgThreshold } from "@/lib/membership/checkStanding";
import { advanceExternalIfComplete } from "@/lib/membership/external";
import { lockAndFindDeniedHousehold, setHouseholdStatus } from "@/lib/membership/householdStatus";
import { fromWhere, openProcess, type ProcessStatus } from "@/lib/membership/lifecycle";
import {
    applyVolunteerFamilyStatus,
    blockedResetStatus,
    notifyClearanceOutcome,
    notifyPaymentOpenOnExistingCheck,
    type ClearanceOutcome,
} from "@/lib/membership/review";

/**
 * Moves a household's open application to match its people's check standing
 * (docs/in-design/person-based-bg-review.md §3.2):
 *
 * - someone in the household has a BLOCKED check review → the application is
 *   BLOCKED, its audit row naming the review;
 * - every review that blocked it is no longer BLOCKED (reset or changed to approve)
 *   and nobody in the household holds one → it resumes at `blockedResetStatus`;
 * - the household qualifies and the application is waiting on its check → its
 *   check is stamped cleared and it converges on payment.
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

    if (result.paidReject) await notifyBoardPaidReject(app.id);
    if (result.advanceExternal) await advanceExternalIfComplete(app.id);
    if (result.clearance) {
        await notifyClearanceOutcome(result.clearance, opts.reviewJustCleared ? undefined : { paymentOpenNotice: notifyPaymentOpenOnExistingCheck });
    }
    return result.steps;
}

export type SettleStep = "denied" | "blocked" | "resumed" | "cleared";

type Settled = { steps: SettleStep[]; paidReject?: boolean; advanceExternal?: boolean; clearance?: ClearanceOutcome };

const ACTOR = systemActor("system:membership-bg-settle");
const BLOCK_REASON = "check review rejected";

/** The from-states of the declared → BLOCKED edges. */
const BLOCKABLE: readonly ProcessStatus[] = ["PENDING_BG_REVIEW", "PENDING_PAYMENT", "PENDING_BG_CLEARANCE"];
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
        select: { id: true, kind: true, status: true, orgMembershipId: true, paidAt: true, bgConsentAt: true, bgClearedAt: true, shopifyOrderId: true },
    });
    if (!process?.orgMembershipId) return { steps: [] };
    const orgMembershipId = process.orgMembershipId;

    const members = await householdCheckStandings(tx, householdId, threshold);
    const blockingNow = members.flatMap((m) => m.disputing.filter((r) => r.status === "BLOCKED").map((r) => r.id));
    const steps: SettleStep[] = [];
    let status: OrgMembershipProcessStatus = process.status;

    if (status === "BLOCKED") {
        const recorded = await recordedBlockers(tx, processId);
        if (recorded === null) return { steps };
        const unrecorded = blockingNow.filter((id) => !recorded.includes(id));
        if (unrecorded.length) await audit(tx, processId, householdId, { status }, { action: BLOCK_REASON, blockingReviewIds: unrecorded });
        if (unrecorded.length || await tx.orgMembershipProcess.count({ where: { id: { in: recorded }, status: "BLOCKED" } })) return { steps };
        const to = blockedResetStatus(process);
        const { count } = await tx.orgMembershipProcess.updateMany({ where: { id: processId, ...fromWhere("BLOCKED") }, data: { status: to, stageEnteredAt: new Date() } });
        if (!count) return { steps };
        await audit(tx, processId, householdId, { status }, { status: to, action: "check review no longer rejected", blockingReviewIds: recorded });
        status = to;
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

    if (process.bgClearedAt || !householdQualifies(members)) return { steps };
    const now = new Date();

    if (STAMPS.includes(status)) {
        const { count } = await tx.orgMembershipProcess.updateMany({ where: { id: processId, bgClearedAt: null, ...fromWhere(status) }, data: { bgClearedAt: now } });
        if (!count) return { steps };
        // ponytail: reviewer volunteer marks live on household attestations, which this never reads; the designation allowlist still applies.
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
 * BLOCKED, or null when it was blocked by something other than this function (a
 * household attestation), which this never moves.
 */
async function recordedBlockers(tx: TxClient, processId: number): Promise<number[] | null> {
    const rows = await tx.auditLog.findMany({
        where: { tableName: "OrgMembershipProcess", affectedEntityId: processId },
        orderBy: { id: "desc" },
        select: { oldData: true, newData: true },
    });
    const ids: number[] = [];
    for (const row of rows) {
        const recorded = field(row.newData, "blockingReviewIds");
        if (Array.isArray(recorded)) ids.push(...recorded.filter((v): v is number => typeof v === "number"));
        if (field(row.newData, "status") === "BLOCKED" && field(row.oldData, "status") !== "BLOCKED") {
            return field(row.newData, "reason") === BLOCK_REASON ? ids : null;
        }
    }
    return null;
}

function field(json: Prisma.JsonValue | null, key: string): Prisma.JsonValue | undefined {
    return json !== null && typeof json === "object" && !Array.isArray(json) ? json[key] : undefined;
}

function audit(tx: TxClient, processId: number, householdId: number, oldData: Prisma.InputJsonObject, newData: Prisma.InputJsonObject) {
    return tx.auditLog.create({
        data: { ...ACTOR, action: "EDIT", tableName: "OrgMembershipProcess", affectedEntityId: processId, secondaryAffectedEntity: householdId, oldData, newData },
    });
}
