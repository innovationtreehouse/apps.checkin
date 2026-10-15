import type { Prisma, OrgMembershipProcess } from "@/generated/prisma/client";
import prisma from "@/lib/prisma";
import { isPrismaError } from "@/lib/prismaUniqueViolation";
import { ReviewError, applicantHousehold } from "@/lib/membership/review";
import { ARCHIVABLE_STATUSES, RESTORABLE_STATUSES, fromWhere, openProcess } from "@/lib/membership/lifecycle";
import { advanceExternalIfComplete } from "@/lib/membership/external";
import { hasHouseholdConflict } from "@/lib/conflictOfInterest";
import { personActor } from "@/lib/auditActor";

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
    if (!(ARCHIVABLE_STATUSES as readonly string[]).includes(process.status)) return "This application cannot be closed from its current step.";
    return null;
}

/**
 * Board "Close application": moves a long-idle, unpaid application to ARCHIVED so it
 * drops off every live list. The step it was closed from is captured on the row
 * (`archivedFromStatus`) in the same write; who/when go to AuditLog. Closing an
 * already-closed application is a no-op.
 *
 * The Zoho signing request stays live on purpose: Zoho charges per request, so
 * close/reopen never recall or recreate one. A signature that lands while closed is
 * picked up after Reopen (by the advance re-run below, or by syncContractStatus on
 * the applicant's next visit), with no new request.
 */
export async function archiveApplication(processId: number, actorId: number) {
    const process = await prisma.orgMembershipProcess.findUnique({ where: { id: processId } });
    if (!process) throw new ReviewError("not_found", "Application not found.");
    if (process.status === "ARCHIVED") return { status: "ARCHIVED" as const };
    await assertNoConflict(process, actorId, "close");
    const refusal = closeRefusal(process);
    if (refusal) throw new ReviewError("wrong_phase", refusal);

    await prisma.$transaction(async (tx) => {
        // CAS on the status just read, still unpaid: a payment or reject landing in
        // between makes this a no-op instead of closing a paid or blocked row.
        const { count } = await tx.orgMembershipProcess.updateMany({
            where: { id: processId, ...fromWhere(process.status), paidAt: null },
            data: { status: "ARCHIVED", archivedFromStatus: process.status, stageEnteredAt: new Date() },
        });
        if (count !== 1) throw new ReviewError("wrong_phase", "This application changed while you were looking at it. Reload and try again.");
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

/**
 * Why reopening would break a household rule, or null. A DENIED household starts
 * nothing; a household has one open application at a time (BLOCKED counts as open:
 * the board must resolve it first); an ACTIVE household gets renewals, never a
 * second joining application. Person-scoped kinds allow one open item per subject.
 */
async function reopenRefusal(tx: Prisma.TransactionClient, process: OrgMembershipProcess, householdId: number | null): Promise<string | null> {
    const membership = householdId == null ? null : await tx.orgMembership.findUnique({ where: { householdId }, select: { status: true } });
    if (membership?.status === "DENIED") return "This household has been denied membership. Restore the household before reopening its application.";
    if (process.kind === "INITIAL" && membership?.status === "ACTIVE") return "This household is already an active member, so its joining application cannot be reopened.";

    const sibling = await tx.orgMembershipProcess.findFirst({
        where: {
            id: { not: process.id },
            ...openProcess.where,
            ...((HOUSEHOLD_KINDS as readonly string[]).includes(process.kind)
                ? { orgMembershipId: process.orgMembershipId, kind: { in: [...HOUSEHOLD_KINDS] } }
                : { subjectPersonId: process.subjectPersonId, kind: process.kind }),
        },
        select: { id: true },
    });
    if (sibling) return `Another application (#${sibling.id}) is already open for this household. Resolve or close it first.`;
    return null;
}

/**
 * Board "Reopen": returns a closed application to the step it was closed from
 * (`archivedFromStatus`, captured by the close write). Refuses with the reason when
 * the household is DENIED or already has another open application, then re-runs the
 * external advance so a gate met while closed doesn't strand the application.
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

    try {
        await prisma.$transaction(async (tx) => {
            // Same lock startIntake/createRenewalProcess take, so a new application
            // can't open between the sibling check and the reopen.
            if (householdId != null) await tx.$queryRaw`SELECT id FROM "OrgMembership" WHERE "householdId" = ${householdId} FOR UPDATE`;
            const refusal = await reopenRefusal(tx, process, householdId);
            if (refusal) throw new ReviewError("wrong_phase", refusal);

            const { count } = await tx.orgMembershipProcess.updateMany({
                where: { id: processId, ...fromWhere("ARCHIVED") },
                data: { status: target, archivedFromStatus: null, stageEnteredAt: new Date() },
            });
            if (count !== 1) return; // a concurrent reopen won; it wrote the audit row
            await tx.auditLog.create({
                data: {
                    ...personActor(actorId),
                    action: "EDIT",
                    tableName: "OrgMembershipProcess",
                    affectedEntityId: processId,
                    oldData: { status: "ARCHIVED" },
                    newData: { status: target, unarchived: true },
                },
            });
        });
    } catch (e) {
        // The partial unique indexes (membership_one_inflight_*) back the sibling check.
        if (isPrismaError(e, "P2002")) {
            throw new ReviewError("wrong_phase", "Another application is already open for this household. Resolve or close it first.");
        }
        throw e;
    }
    const advanced = await advanceExternalIfComplete(processId);
    return { status: advanced?.status ?? target };
}
