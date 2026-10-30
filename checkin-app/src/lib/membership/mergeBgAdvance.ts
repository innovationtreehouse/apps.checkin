import prisma from "@/lib/prisma";
import type { TxClient } from "@/lib/db-client";
import { logBackendError } from "@/lib/logger";
import { fromWhere } from "@/lib/membership/lifecycle";
import { advanceExternalIfComplete } from "@/lib/membership/external";
import { bgFreshThreshold, householdBgIsFresh, nextBoundary } from "@/lib/membership/renewal";
import { applyVolunteerFamilyStatus, clearBackgroundCheck, notifyClearanceOutcome, notifyPaymentOpenOnExistingCheck, reviewTransaction } from "@/lib/membership/review";
import { carriedComplianceDate } from "@/lib/person/merge/plan";

/**
 * A participant merge moves the newer of the two `lastBackgroundCheck` dates onto
 * the survivor, which can make a household covered while its in-flight application
 * is still parked waiting on a check. This runs when the merge is what flipped the
 * household to covered, and advances what it now covers.
 *
 * Scope: household INITIAL/RENEWAL processes only. Every query goes through
 * `orgMembership`, which structurally excludes PERSON_BG and PERSON_AGREEMENT —
 * both carry `orgMembershipId: null`. `householdBgIsFresh` asks about household
 * LEADS, so answering it for an adult child's own PERSON_BG would clear their
 * check because a parent's is fresh.
 *
 * Advance only: it acts on rows whose `bgClearedAt` is null and never unstamps one.
 *
 * Approvals do not hold up a carried-in check; they stay on the row as a record. A
 * standing rejection stops it, and so does a board reset.
 */

/** A process this carryover may act on. */
type Candidate = { id: number; orgMembershipId: number | null };

/** The boundary and recheck period in force, from live board settings. */
async function liveBgPolicy() {
    const settings = await prisma.boardSettings.findUnique({ where: { id: 1 } });
    const boundary = settings?.orgMembershipYearBoundary ? nextBoundary(settings.orgMembershipYearBoundary, new Date()) : null;
    return { boundary, recheckMonths: settings?.bgRecheckMonths };
}

/** `householdBgIsFresh` against live board settings. Callers need the answer, not the settings row. */
export async function householdBgFresh(householdId: number | null): Promise<boolean> {
    if (!householdId) return false;
    const { boundary, recheckMonths } = await liveBgPolicy();
    return householdBgIsFresh(householdId, boundary, recheckMonths);
}

type BgSubject = { householdId: number | null; isHouseholdLead: boolean; lastBackgroundCheck: Date | null };

/**
 * What the merge preview tells the operator about the background-check date: the date
 * the keeper would adopt, and whether adopting it would make the household valid, the
 * condition under which `advanceHouseholdBgAfterMerge` acts. Null when the keeper's date
 * stands. A merge never changes the keeper's lead flag, and with no lead fresh today the
 * carried date on the keeper is the only thing that can make the household fresh.
 */
export async function mergeBgNotice(keep: BgSubject, merge: BgSubject): Promise<{ date: Date; makesHouseholdValid: boolean } | null> {
    const date = carriedComplianceDate(keep.lastBackgroundCheck, merge.lastBackgroundCheck);
    if (!date) return null;
    if (!keep.householdId || !keep.isHouseholdLead) return { date, makesHouseholdValid: false };
    const { boundary, recheckMonths } = await liveBgPolicy();
    if (await householdBgIsFresh(keep.householdId, boundary, recheckMonths)) return { date, makesHouseholdValid: false };
    const threshold = bgFreshThreshold(boundary, recheckMonths);
    return { date, makesHouseholdValid: !!threshold && date.getTime() >= threshold.getTime() };
}

/**
 * Re-evaluate background-check coverage for a merge survivor's household. Run
 * AFTER the merge transaction commits: the survivor's live leads are only final
 * then, and the predicate reads the root client.
 *
 * The question is "did THIS merge make the household covered?", so
 * `wasFreshBeforeMerge` carries the same predicate read before the transaction.
 * A household already covered has its rows parked for a reason no merge changed —
 * a board reset re-opens a review whose leads still hold a valid check — and
 * stamping one of those ends a re-review that has no way back.
 *
 * Never throws — the merge has already committed, so a failure here must not be
 * reported to the operator as a failed merge. It lands in the error log instead.
 */
export async function advanceHouseholdBgAfterMerge(
    householdId: number | null,
    actorId: number,
    mergedPersonId: number,
    wasFreshBeforeMerge: boolean,
): Promise<void> {
    if (!householdId || wasFreshBeforeMerge) return;
    const source = { via: "merge" as const, sourcePersonId: mergedPersonId };
    try {
        if (!(await householdBgFresh(householdId))) return;

        await stampPendingExternal(householdId, actorId, source);
        await stampParallelPayment(householdId, actorId, source);
        for (const held of HELD_STATES) await clearHeldRow(householdId, actorId, mergedPersonId, held);
    } catch (error) {
        await logBackendError(error, "membership merge background-check advance", { householdId, mergedPersonId });
    }
}

type Provenance = { via: "merge"; sourcePersonId: number };

/**
 * Whether a board reset sent this review back. A reset asks for two new approvals,
 * so a carried-in check never stands in for them. Read under the process lock.
 */
async function wasBoardReset(tx: TxClient, processId: number): Promise<boolean> {
    const reset = await tx.auditLog.findFirst({
        where: { tableName: "OrgMembershipProcess", affectedEntityId: processId, newData: { path: ["action"], equals: "board reset" } },
        select: { id: true },
    });
    return reset !== null;
}

/** Household INITIAL/RENEWAL rows at `from` that still owe a background check. */
function uncleared(householdId: number, from: object, extra: object = {}): Promise<Candidate[]> {
    return prisma.orgMembershipProcess.findMany({
        where: { orgMembership: { householdId }, bgClearedAt: null, ...extra, ...from },
        select: { id: true, orgMembershipId: true },
    });
}

/**
 * Stamp `bgClearedAt` under a CAS on the from-state, and apply the volunteer status:
 * the fresh-check shortcut means `clearBackgroundCheck` never runs this cycle, and
 * without it a pre-designated or reviewer-marked volunteer household gets the
 * non-volunteer membership fee (#874). Returns false when the row moved on under us.
 *
 * One transaction, FOR UPDATE first: a rejection only stops the stamp if it is read
 * under the lock, and the stamp, its audit row and the volunteer write must land
 * together or not at all.
 */
async function stampBgCleared(process: Candidate, householdId: number, actorId: number, from: object, source: Provenance): Promise<boolean> {
    return prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "OrgMembershipProcess" WHERE id = ${process.id} FOR UPDATE`;
        const attestations = await tx.backgroundCheckAttestation.findMany({
            where: { processId: process.id },
            select: { result: true, isMarkedVolunteerFamily: true },
        });
        if (attestations.some((a) => a.result === "REJECT")) return false;
        if (await wasBoardReset(tx, process.id)) return false;
        const { count } = await tx.orgMembershipProcess.updateMany({
            where: { id: process.id, bgClearedAt: null, ...from },
            data: { bgClearedAt: new Date() },
        });
        if (count !== 1) return false;
        await tx.auditLog.create({
            data: {
                actorId,
                action: "EDIT",
                tableName: "OrgMembershipProcess",
                affectedEntityId: process.id,
                secondaryAffectedEntity: householdId,
                newData: { bgClearedAt: true, ...source, reason: "still-valid background check carried in by participant merge" },
            },
        });
        await applyVolunteerFamilyStatus(tx, process.orgMembershipId!, householdId, attestations.some((a) => a.isMarkedVolunteerFamily));
        return true;
    });
}

/**
 * PENDING_EXTERNAL_ACTION: the applicant's card now reads "no new background check
 * needed". `advanceExternalIfComplete` owns the status edge and no-ops until the
 * agreement is signed — but a row whose contract is ALREADY signed has no other
 * event left to fire it, so without this call it strands with its gate met (the
 * reason `submitIntake` re-runs the advance after its own shortcut).
 */
async function stampPendingExternal(householdId: number, actorId: number, source: Provenance): Promise<void> {
    const from = fromWhere("PENDING_EXTERNAL_ACTION");
    for (const process of await uncleared(householdId, from)) {
        if (!(await stampBgCleared(process, householdId, actorId, from, source))) continue;
        await advanceExternalIfComplete(process.id);
    }
}

/**
 * PENDING_PAYMENT (parallel track): status is already correct, so the stamp IS the
 * work — it drops the row out of the reviewer queue and pre-decides `activate()`'s
 * ACTIVE-vs-PENDING_BG_CLEARANCE branch.
 */
async function stampParallelPayment(householdId: number, actorId: number, source: Provenance): Promise<void> {
    const from = fromWhere("PENDING_PAYMENT");
    for (const process of await uncleared(householdId, from)) {
        await stampBgCleared(process, householdId, actorId, from, source);
    }
}

/**
 * The states a stamp alone would strand, because nothing but `clearBackgroundCheck`
 * moves them: legacy rows parked at PENDING_BG_REVIEW, and PENDING_BG_CLEARANCE — paid,
 * membership INACTIVE, the carried check the only thing left. Each pairs its status with
 * its own CAS clause so the guard↔TRANSITIONS parity test can see both from-states.
 */
const HELD_STATES = [
    { status: "PENDING_BG_REVIEW", from: fromWhere("PENDING_BG_REVIEW") },
    { status: "PENDING_BG_CLEARANCE", from: fromWhere("PENDING_BG_CLEARANCE") },
] as const;

/**
 * Stamping `bgClearedAt` on a held row drops it out of the reviewer queue with no exit
 * but archival. So run the real clearance, which stamps and converges in one write —
 * to PENDING_PAYMENT if the membership fee is still owed, to ACTIVE if it is already paid.
 * No standing rejection, re-read under the lock.
 */
async function clearHeldRow(
    householdId: number,
    actorId: number,
    mergedPersonId: number,
    held: (typeof HELD_STATES)[number],
): Promise<void> {
    const { status, from } = held;
    for (const process of await uncleared(householdId, from)) {
        const outcome = await reviewTransaction(async (tx) => {
            // clearBackgroundCheck's contract; also serializes against a concurrent attest.
            await tx.$queryRaw`SELECT id FROM "OrgMembershipProcess" WHERE id = ${process.id} FOR UPDATE`;
            const fresh = await tx.orgMembershipProcess.findUnique({
                where: { id: process.id },
                select: { status: true, bgClearedAt: true, _count: { select: { attestations: { where: { result: "REJECT" } } } } },
            });
            if (!fresh || fresh.status !== status || fresh.bgClearedAt || fresh._count.attestations > 0) return null;
            if (await wasBoardReset(tx, process.id)) return null;
            return clearBackgroundCheck(tx, process.id, actorId, { where: from }, {
                provenance: {
                    via: "merge",
                    sourcePersonId: mergedPersonId,
                    reason: "still-valid background check carried in by participant merge",
                },
            });
        });
        if (outcome) await notifyClearanceOutcome(outcome, { paymentOpenNotice: notifyPaymentOpenOnExistingCheck });
    }
}
