import prisma from "@/lib/prisma";
import { personActor } from "@/lib/auditActor";
import { calculateAge } from "@/lib/time";
import { backgroundCheckProvider } from "@/lib/membership/background-check/manual-adapter";
import { checkValidForApplication } from "@/lib/membership/checkStanding";
import { advanceExternalIfComplete, ExternalError } from "@/lib/membership/external";
import { fromWhere, openProcess, personBgOpen } from "@/lib/membership/lifecycle";
import { notifyReviewers } from "@/lib/membership/review";
import { settleAfterEvent } from "@/lib/membership/settleHouseholdBg";

/**
 * "Check started": someone marks that a person's background check was started in
 * the outside tool, which puts that person's own check review in the reviewers'
 * queue. It is
 * recorded only on the person's PERSON_BG review, never on a household application,
 * and it approves nothing.
 */

export type CheckStartedState = "NEEDS_MARKING" | "NOTHING_TO_DO";

export interface CheckStartedRow {
    personId: number;
    name: string | null;
    state: CheckStartedState;
}

const notAllowed = () => new ExternalError("not_lead", "Only a household lead can mark another person's check started.");

type AgeFacts = { dateOfBirth: Date | null; isDeclaredAdult: boolean };

/** Under 18 by a recorded date of birth. A person of unknown age is not a known minor. */
function isKnownMinor(person: AgeFacts, now: Date): boolean {
    return !person.isDeclaredAdult && !!person.dateOfBirth && calculateAge(person.dateOfBirth, now) < 18;
}

/**
 * Marks `subjectPersonId`'s check started. The subject themself, a household lead
 * of the subject's household, a sysadmin or a Board member may mark it; no
 * own-household bar applies, since marking decides nothing. A known minor is
 * refused.
 *
 * Under the Person row lock: a BLOCKED review is left as it is and nothing else
 * runs; an open PENDING_BG_REVIEW review is reused, its requested household filled
 * in when empty; otherwise a review naming the subject is created. The flag is
 * stamped once, with one audit row naming the actor, and the reviewers are told on
 * that first stamp. The subject's household is then settled and its open
 * application offered the advance to payment.
 */
export async function markCheckStarted(subjectPersonId: number, actorId: number): Promise<{ processId: number | null }> {
    const [actor, subject] = await Promise.all([
        prisma.person.findUnique({ where: { id: actorId }, select: { id: true, householdId: true, isHouseholdLead: true, isSysadmin: true, isBoardMember: true } }),
        prisma.person.findUnique({ where: { id: subjectPersonId }, select: { id: true, householdId: true, dateOfBirth: true, isDeclaredAdult: true } }),
    ]);
    if (!actor) throw new ExternalError("not_found", "Person not found.");
    const privileged = actor.isSysadmin || actor.isBoardMember;
    // Only the Board and sysadmins learn whether an id exists; anyone else is told only that they may not mark it.
    if (!subject) throw privileged ? new ExternalError("not_found", "Person not found.") : notAllowed();
    const leadsSubjectHousehold = actor.isHouseholdLead && actor.householdId !== null && actor.householdId === subject.householdId;
    if (actor.id !== subject.id && !leadsSubjectHousehold && !privileged) throw notAllowed();
    const now = new Date();
    if (isKnownMinor(subject, now)) throw new ExternalError("wrong_phase", "A person under 18 is never background-checked.");

    const outcome = await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Person" WHERE id = ${subjectPersonId} FOR UPDATE`;
        const open = await tx.orgMembershipProcess.findMany({
            where: { kind: "PERSON_BG", subjectPersonId, ...personBgOpen.where },
            orderBy: { id: "desc" },
            select: { id: true, status: true, bgConsentAt: true, requestedForHouseholdId: true },
        });
        if (open.some((r) => r.status === "BLOCKED")) return { processId: open.find((r) => r.status === "BLOCKED")!.id, stamped: false, settles: false };

        const review = open[0];
        if (!review) {
            const created = await tx.orgMembershipProcess.create({
                data: { kind: "PERSON_BG", status: "PENDING_BG_REVIEW", subjectPersonId, requestedForHouseholdId: subject.householdId, bgConsentAt: now, stageEnteredAt: now },
            });
            await tx.auditLog.create({
                data: {
                    ...personActor(actorId),
                    action: "CREATE",
                    tableName: "OrgMembershipProcess",
                    affectedEntityId: created.id,
                    secondaryAffectedEntity: subject.householdId,
                    newData: { kind: "PERSON_BG", status: "PENDING_BG_REVIEW", subjectPersonId, requestedForHouseholdId: subject.householdId, checkStarted: true },
                },
            });
            return { processId: created.id, stamped: true, settles: true };
        }

        const fillsHousehold = review.requestedForHouseholdId === null && subject.householdId !== null;
        const { count } = await tx.orgMembershipProcess.updateMany({
            where: { id: review.id, bgConsentAt: null, ...fromWhere("PENDING_BG_REVIEW") },
            data: { bgConsentAt: now, ...(fillsHousehold ? { requestedForHouseholdId: subject.householdId } : {}) },
        });
        if (count === 1) {
            await tx.auditLog.create({
                data: {
                    ...personActor(actorId),
                    action: "EDIT",
                    tableName: "OrgMembershipProcess",
                    affectedEntityId: review.id,
                    newData: { checkStarted: true, ...(fillsHousehold ? { requestedForHouseholdId: subject.householdId } : {}) },
                },
            });
        } else if (fillsHousehold) {
            await tx.orgMembershipProcess.updateMany({ where: { id: review.id, requestedForHouseholdId: null }, data: { requestedForHouseholdId: subject.householdId } });
        }
        return { processId: review.id, stamped: count === 1, settles: true };
    });

    if (outcome.stamped) await notifyReviewers();
    if (outcome.settles && subject.householdId !== null) {
        await settleAfterEvent(subject.householdId, "check started", {}, { processId: outcome.processId });
        const app = await prisma.orgMembershipProcess.findFirst({
            where: { orgMembership: { householdId: subject.householdId }, kind: { in: ["INITIAL", "RENEWAL"] }, ...openProcess.where },
            orderBy: { id: "desc" },
            select: { id: true },
        });
        if (app) await advanceExternalIfComplete(app.id);
    }
    return { processId: outcome.processId };
}

/**
 * The rows /membership offers for marking: the caller's own, and for a household
 * lead each other member of their household who is not a known minor. A row needs
 * marking while none of its person's open or blocked reviews has the check started
 * and they hold no clearance valid at the start of the year their household
 * application is for (the live year when none is open); anything
 * else, including a known minor's own row, is "nothing to do".
 */
export async function checkStartedRows(callerId: number): Promise<CheckStartedRow[]> {
    const select = { id: true, name: true, dateOfBirth: true, isDeclaredAdult: true, lastBackgroundCheck: true } as const;
    const caller = await prisma.person.findUnique({ where: { id: callerId }, select: { ...select, householdId: true, isHouseholdLead: true } });
    if (!caller) return [];
    const now = new Date();
    const others = caller.isHouseholdLead && caller.householdId !== null
        ? (await prisma.person.findMany({ where: { householdId: caller.householdId, id: { not: callerId } }, orderBy: { id: "asc" }, select })).filter((p) => !isKnownMinor(p, now))
        : [];
    const people = [caller, ...others];
    const app = caller.householdId === null ? null : await prisma.orgMembershipProcess.findFirst({
        where: { orgMembership: { householdId: caller.householdId }, kind: { in: ["INITIAL", "RENEWAL"] }, ...openProcess.where },
        orderBy: { id: "desc" },
        select: { appliesToYear: true, createdAt: true },
    });
    const [threshold, flagged] = await Promise.all([
        checkValidForApplication(app ?? { appliesToYear: null, createdAt: now }),
        prisma.orgMembershipProcess.findMany({
            where: { kind: "PERSON_BG", subjectPersonId: { in: people.map((p) => p.id) }, bgConsentAt: { not: null }, ...personBgOpen.where },
            select: { subjectPersonId: true },
        }),
    ]);
    const started = new Set(flagged.map((r) => r.subjectPersonId));
    return people.map((p) => {
        const cleared = !!threshold && !!p.lastBackgroundCheck && p.lastBackgroundCheck >= threshold;
        const needs = !started.has(p.id) && !cleared && !isKnownMinor(p, now);
        return { personId: p.id, name: p.name, state: needs ? "NEEDS_MARKING" : "NOTHING_TO_DO" };
    });
}

export interface OwnBackgroundCheck {
    /** The caller's own open review has the check started. */
    checkStarted: boolean;
    /** The outside background-check tool's link, where consent is given. */
    deepLinkUrl: string | null;
}

/** The caller's own check as the /membership Background checks panel shows it. */
export async function getOwnBackgroundCheck(personId: number): Promise<OwnBackgroundCheck> {
    const started = await prisma.orgMembershipProcess.count({
        where: { kind: "PERSON_BG", subjectPersonId: personId, bgConsentAt: { not: null }, ...personBgOpen.where },
    });
    return { checkStarted: started > 0, deepLinkUrl: await backgroundCheckProvider.getConsentDeepLink() };
}
