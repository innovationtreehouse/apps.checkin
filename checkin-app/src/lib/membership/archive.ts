import type { Prisma, OrgMembershipProcess } from "@/generated/prisma/client";
import prisma from "@/lib/prisma";
import { isPrismaError } from "@/lib/prismaUniqueViolation";
import { ReviewError, applicantHousehold, reviewHouseholds, wrongPersonClosedAt } from "@/lib/membership/review";
import { reviewHoldsRejection } from "@/lib/membership/checkStanding";
import { CLOSABLE_STATUSES, RESTORABLE_STATUSES, RESTORE_CLOSABLE_STATUSES, fromWhere, openProcess } from "@/lib/membership/lifecycle";
import { advanceExternalIfComplete, pickUpMissedSignature } from "@/lib/membership/external";
import { hasHouseholdConflict } from "@/lib/conflictOfInterest";
import { personActor, type AuditActor } from "@/lib/auditActor";
import { type TxClient } from "@/lib/db-client";
import { lockHouseholdRows } from "@/lib/household/archiveGuard";
import { applicationYear, liveMembershipYear, membershipYearEnded, membershipYearLabel, reopenYearRefusal } from "@/lib/programYear";
import { orgToday } from "@/lib/appSettings";

// Loaded on use: settleHouseholdBg imports review.ts, and a static import closes that cycle at load.
const settleModule = () => import("@/lib/membership/settleHouseholdBg");

// Code says "archive"; the board sees "Close application" / "Reopen". "Archive" is
// reserved for archiving a household.

async function assertNoConflict(process: OrgMembershipProcess, actorId: number, verb: "close" | "reopen") {
    if (await hasHouseholdConflict(prisma, actorId, await applicantHousehold(prisma, process))) {
        throw new ReviewError("same_household_applicant", `You cannot ${verb} your own household's application — someone outside your household must.`);
    }
}

/** Why a status can't be closed, or null when it can. Close is for long-idle, unpaid applications. */
function closeRefusal(process: OrgMembershipProcess): string | null {
    if (process.status === "ACTIVE") return "A completed membership cannot be closed.";
    if (process.status === "BLOCKED") return "A blocked application cannot be closed. Reset it for re-review, or clear it with a board override.";
    if (process.paidAt) return "This application has a payment recorded. Refund it in Shopify and record the refund first, then close it.";
    if (!(CLOSABLE_STATUSES as readonly string[]).includes(process.status)) return "This application cannot be closed from its current step.";
    return null;
}

/**
 * Board "Close application": moves a long-idle, unpaid application to ARCHIVED so it
 * drops off every live list. The step it was closed from is captured on the row
 * (`archivedFromStatus`) in the same write; who/when go to AuditLog. Closing an
 * already-closed application is a no-op.
 *
 * The Zoho signing request stays live on purpose: Zoho charges per request, so
 * close/reopen never recall or recreate one. The webhook ignores a closed application,
 * so a signature that lands while closed is asked of Zoho at Reopen, or at "Resume
 * signing" if Zoho is down then, with no new request.
 */
export async function archiveApplication(processId: number, actorId: number) {
    const process = await prisma.orgMembershipProcess.findUnique({ where: { id: processId } });
    if (!process) throw new ReviewError("not_found", "Application not found.");
    if (process.status === "ARCHIVED") return { status: "ARCHIVED" as const };
    await assertNoConflict(process, actorId, "close");
    const refusal = closeRefusal(process);
    if (refusal) throw new ReviewError("wrong_phase", refusal);
    // A check review that still carries a rejection would lose it on closing.
    if (process.kind === "PERSON_BG" && await reviewHoldsRejection(prisma, processId)) {
        throw new ReviewError("wrong_phase", "This check review still carries a rejection, so it cannot be closed. It needs a decision from two new reviewers.");
    }

    await prisma.$transaction(async (tx) => {
        // CAS on the status just read, still unpaid: a payment or reject landing in
        // between makes this a no-op instead of closing a paid or blocked row.
        const { count } = await tx.orgMembershipProcess.updateMany({
            where: { id: processId, ...fromWhere(process.status), paidAt: null },
            data: { status: "ARCHIVED", archivedFromStatus: process.status, stageEnteredAt: new Date(), isPaymentPlanRequested: false },
        });
        if (count !== 1) {
            // A concurrent close of this application won; it wrote the audit row.
            const now = await tx.orgMembershipProcess.findUnique({ where: { id: processId }, select: { status: true } });
            if (now?.status === "ARCHIVED") return;
            throw new ReviewError("wrong_phase", "This application changed while you were looking at it. Reload and try again.");
        }
        await tx.auditLog.create({
            data: {
                ...personActor(actorId),
                action: "EDIT",
                tableName: "OrgMembershipProcess",
                affectedEntityId: processId,
                oldData: { status: process.status },
                newData: { status: "ARCHIVED" },
            },
        });
    });
    return { status: "ARCHIVED" as const };
}

const HOUSEHOLD_KINDS = ["INITIAL", "RENEWAL"] as const;

const RESTORE_CLOSE_REASON = "household restored";

/**
 * Locks a household's membership, household and applications FOR UPDATE, in the
 * order lib/lockOrder.ts states, and returns the open applications, for a restore
 * or an archive to close.
 */
export async function lockOpenApplications(tx: TxClient, orgMembershipId: number) {
    const [membership] = await tx.$queryRaw<{ householdId: number }[]>`SELECT "householdId" FROM "OrgMembership" WHERE id = ${orgMembershipId} FOR UPDATE`;
    if (membership) await lockHouseholdRows(tx, [membership.householdId]);
    await tx.$queryRaw`SELECT id FROM "OrgMembershipProcess" WHERE "orgMembershipId" = ${orgMembershipId} ORDER BY id FOR UPDATE`;
    return tx.orgMembershipProcess.findMany({
        where: { orgMembershipId, kind: { in: [...HOUSEHOLD_KINDS] }, ...openProcess.where },
        select: { id: true, status: true, paidAt: true },
    });
}

/** How many applications {@link lockOpenApplications} would return now, read without locking. */
export function countOpenApplications(tx: TxClient, orgMembershipId: number) {
    return tx.orgMembershipProcess.count({ where: { orgMembershipId, kind: { in: [...HOUSEHOLD_KINDS] }, ...openProcess.where } });
}

/**
 * Closes the open applications of a household the board is restoring from DENIED or
 * archiving, so nothing decided before carries across. Refuses, rolling back the
 * caller's transaction, while one still has a payment recorded or sits at a step
 * this cannot close.
 */
export async function closeForRestore(
    tx: TxClient,
    open: Awaited<ReturnType<typeof lockOpenApplications>>,
    actor: AuditActor,
    action: "restore" | "archive" = "restore",
) {
    if (open.some((p) => p.paidAt)) {
        throw new ReviewError("wrong_phase", `This household has an application with a payment recorded. Refund it in Shopify and record the refund first, then ${action} the household.`);
    }
    if (open.some((p) => !(RESTORE_CLOSABLE_STATUSES as readonly string[]).includes(p.status))) {
        throw new ReviewError("wrong_phase", `This household has an application at a step a ${action} cannot close. Resolve that application first, then ${action} the household.`);
    }
    for (const p of open) {
        const { count } = await tx.orgMembershipProcess.updateMany({
            where: { id: p.id, ...fromWhere(p.status), paidAt: null },
            data: { status: "ARCHIVED", archivedFromStatus: p.status, stageEnteredAt: new Date(), isPaymentPlanRequested: false },
        });
        if (count !== 1) throw new ReviewError("wrong_phase", "An application in this household changed while you were acting on it. Reload and try again.");
        await tx.auditLog.create({
            data: {
                ...actor,
                action: "EDIT",
                tableName: "OrgMembershipProcess",
                affectedEntityId: p.id,
                oldData: { status: p.status },
                newData: { status: "ARCHIVED", reason: action === "restore" ? RESTORE_CLOSE_REASON : "household archived" },
            },
        });
    }
}

/**
 * Why reopening would break a household rule, or null. A DENIED household starts
 * nothing; a household has one open application at a time (BLOCKED counts as open:
 * the board must resolve it first); an ACTIVE household gets renewals, never a
 * second joining application; a household application is reopened only within its
 * own membership year. Person-scoped kinds allow one open item per subject.
 */
async function reopenRefusal(tx: Prisma.TransactionClient, process: OrgMembershipProcess, householdId: number | null, boundary: Date | null | undefined, today: Date): Promise<string | null> {
    const yearRefusal = process.kind === "PERSON_AGREEMENT"
        ? agreementYearRefusal(process.membershipYear, boundary, today)
        : reopenYearRefusal(process.kind, applicationYear(process, boundary), boundary, today);
    if (yearRefusal) return yearRefusal;

    const membership = householdId == null ? null : await tx.orgMembership.findUnique({ where: { householdId }, select: { status: true } });
    if (membership?.status === "DENIED") return "This household has been denied membership. Restore the household before reopening its application.";
    if (process.kind === "INITIAL" && membership?.status === "ACTIVE") return "This household is already an active member, so its joining application cannot be reopened.";

    const sibling = await tx.orgMembershipProcess.findFirst({
        where: {
            id: { not: process.id },
            ...openProcess.where,
            ...((HOUSEHOLD_KINDS as readonly string[]).includes(process.kind)
                ? { orgMembershipId: process.orgMembershipId, kind: { in: [...HOUSEHOLD_KINDS] } }
                : process.subjectPersonId === null && process.requestedForHouseholdId !== null
                    ? { subjectPersonId: null, requestedForHouseholdId: process.requestedForHouseholdId, kind: process.kind }
                    : { subjectPersonId: process.subjectPersonId, kind: process.kind }),
        },
        select: { id: true },
    });
    if (sibling) return `Another application (#${sibling.id}) is already open for this household. Resolve or close it first.`;
    return null;
}

/** Why an agreement for `year` can't be reopened, or null: its year has ended. */
function agreementYearRefusal(year: number | null, boundary: Date | null | undefined, today: Date): string | null {
    if (year == null || !boundary || !membershipYearEnded(year, boundary, today)) return null;
    return `This agreement is for ${membershipYearLabel(year)}, which has ended, so it can't be reopened.`;
}

/**
 * Whether the household was denied at any point after this application closed, or the
 * close was the restore's own. Zoho gives no signing time, so a signature found at
 * Reopen may have been made during that denial.
 */
async function deniedSinceClose(tx: Prisma.TransactionClient, processId: number, householdId: number): Promise<boolean> {
    const close = await tx.auditLog.findFirst({
        where: { tableName: "OrgMembershipProcess", affectedEntityId: processId, newData: { path: ["status"], equals: "ARCHIVED" } },
        orderBy: { id: "desc" },
        select: { id: true },
    });
    if (!close) return false;
    const evidence = await tx.auditLog.findFirst({
        where: {
            OR: [
                { id: close.id, newData: { path: ["reason"], equals: RESTORE_CLOSE_REASON } },
                {
                    tableName: "OrgMembership",
                    secondaryAffectedEntity: householdId,
                    id: { gt: close.id },
                    OR: [{ newData: { path: ["status"], equals: "DENIED" } }, { oldData: { path: ["status"], equals: "DENIED" } }],
                },
            ],
        },
        select: { id: true },
    });
    return evidence !== null;
}

const FORGET_SIGNING_REQUEST = { zohoEnvelopeId: null, zohoActionId: null, zohoSignerPersonId: null };

/**
 * Board "Reopen": returns a closed application to the step it was closed from
 * (`archivedFromStatus`, captured by the close write). Refuses with the reason when
 * the household is DENIED, already has another open application, the next
 * year's renewal window has opened since the application's own year, or an
 * agreement's year has ended, then picks up a
 * signature made while closed and re-runs the external advance so a gate met while
 * closed doesn't strand the application. When the household was denied since the
 * close, the unsigned signing request is forgotten in the reopen write instead, and
 * the family signs again. A household row closed with a payment and no year reopens
 * with the year its payment falls in. The households it touches are then settled on their
 * people's check standing, which may block it or open its check review.
 */
export async function unarchiveApplication(processId: number, actorId: number) {
    const process = await prisma.orgMembershipProcess.findUnique({ where: { id: processId } });
    if (!process) throw new ReviewError("not_found", "Application not found.");
    if (process.status !== "ARCHIVED") throw new ReviewError("wrong_phase", "Only a closed application can be reopened.");
    await assertNoConflict(process, actorId, "reopen");

    const target = process.archivedFromStatus ?? undefined;
    if (!target || !RESTORABLE_STATUSES.has(target)) {
        throw new ReviewError("wrong_phase", "Cannot determine the step this application was closed from.");
    }
    const householdId = await applicantHousehold(prisma, process);
    const today = await orgToday();

    let reopened: { forgotRequest: boolean } | null;
    try {
        reopened = await prisma.$transaction(async (tx) => {
            // Same lock startIntake/createRenewalProcess take, so a new application
            // can't open between the sibling check and the reopen.
            if (householdId != null) await tx.$queryRaw`SELECT id FROM "OrgMembership" WHERE "householdId" = ${householdId} FOR UPDATE`;
            if (process.kind === "PERSON_BG" && await wrongPersonClosedAt(tx, processId)) {
                throw new ReviewError("wrong_phase", "The Board closed this check review as opened for the wrong person. Reopen it with a reason instead.");
            }
            const settings = await tx.boardSettings.findUnique({ where: { id: 1 }, select: { orgMembershipYearBoundary: true } });
            const refusal = await reopenRefusal(tx, process, householdId, settings?.orgMembershipYearBoundary, today);
            if (refusal) throw new ReviewError("wrong_phase", refusal);
            const forgotRequest = householdId != null && process.zohoEnvelopeId != null && process.contractSignedAt == null
                && await deniedSinceClose(tx, processId, householdId);
            // A row closed with a payment and no year gets the year its payment falls in, as a payment stamps it.
            const paidYear = process.paidAt && process.appliesToYear == null && (HOUSEHOLD_KINDS as readonly string[]).includes(process.kind)
                ? liveMembershipYear(settings?.orgMembershipYearBoundary, process.paidAt)
                : null;
            const yearFill = paidYear == null ? {} : { appliesToYear: paidYear };

            const { count } = await tx.orgMembershipProcess.updateMany({
                where: { id: processId, ...fromWhere("ARCHIVED") },
                data: { status: target, archivedFromStatus: null, stageEnteredAt: new Date(), ...yearFill, ...(forgotRequest ? FORGET_SIGNING_REQUEST : {}) },
            });
            if (count !== 1) return null; // a concurrent reopen won; it wrote the audit row
            await tx.auditLog.create({
                data: {
                    ...personActor(actorId),
                    action: "EDIT",
                    tableName: "OrgMembershipProcess",
                    affectedEntityId: processId,
                    oldData: { status: "ARCHIVED", ...(forgotRequest ? { zohoEnvelopeId: process.zohoEnvelopeId, zohoActionId: process.zohoActionId, zohoSignerPersonId: process.zohoSignerPersonId } : {}) },
                    newData: { status: target, unarchived: true, ...yearFill, ...(forgotRequest ? { ...FORGET_SIGNING_REQUEST, reason: "household denied since close" } : {}) },
                },
            });
            return { forgotRequest };
        });
    } catch (e) {
        // The partial unique indexes (membership_one_inflight_*) back the sibling check.
        if (isPrismaError(e, "P2002")) {
            throw new ReviewError("wrong_phase", "Another application is already open for this household. Resolve or close it first.");
        }
        throw e;
    }
    if (reopened && !reopened.forgotRequest) await pickUpMissedSignature(process);
    const { settleAfterEvent } = await settleModule();
    for (const id of await reviewHouseholds(prisma, process)) {
        await settleAfterEvent(id, "reopen", {}, { processId });
    }
    const advanced = await advanceExternalIfComplete(processId);
    return { status: advanced?.status ?? target };
}
