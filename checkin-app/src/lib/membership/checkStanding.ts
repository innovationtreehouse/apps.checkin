import type { Prisma } from "@/generated/prisma/client";
import type { DbClient } from "@/lib/db-client";
import prisma from "@/lib/prisma";
import { personBgOpen, type ProcessStatus } from "@/lib/membership/lifecycle";
import { bgFreshThreshold, nextBoundary } from "@/lib/membership/renewal";

/**
 * A person's background-check standing, derived from their own check reviews
 * (PERSON_BG rows naming them) and their `lastBackgroundCheck`
 * (docs/rules/membership.md, Application and review).
 *
 * - DISPUTED: a review is BLOCKED, or its rejection was Board-reset or changed to
 *   approve and it has not cleared since. It beats CLEARED: an old clearance never
 *   outweighs a new rejection.
 * - CLEARED: `lastBackgroundCheck` inside the window, nothing disputed.
 * - PENDING: a review naming them is open with consent, nothing disputed.
 * - NONE: none of the above.
 */
export type CheckStanding = "CLEARED" | "DISPUTED" | "PENDING" | "NONE";

/** One of the person's own check reviews, reduced to what standing reads. */
export type CheckReviewFacts = {
    id: number;
    status: ProcessStatus;
    bgConsentAt: boolean;
    /** Its rejection was Board-reset or changed to approve since its person was named. */
    sentBack: boolean;
};

type AuditFacts = { oldData: Prisma.JsonValue | null; newData: Prisma.JsonValue | null };

/**
 * A review's rejection history read from its audit rows, oldest first. Only a
 * rejection sent back counts: a Board reset of a BLOCKED review, or the rejector's
 * change to approve, which no later undo or reset takes back. A row that clears the
 * review's person (`newData.subjectPersonId: null`) begins a fresh history for whoever
 * is named next, but each person cleared off it keeps their earlier rejection: naming
 * them again, however many resets later, brings it back.
 *
 * - `sentBack`: the review is sent back for its current person.
 * - `heldRejection`: a person cleared off the review left a rejection on it that
 *   naming them again would bring back.
 */
export function rejectionHistory(rows: readonly AuditFacts[]): { sentBack: boolean; heldRejection: boolean } {
    let sentBack = false;
    let current: Prisma.JsonValue | undefined;
    const cleared = new Map<Prisma.JsonValue | undefined, boolean>();
    for (const { oldData, newData } of rows) {
        const action = jsonField(newData, "action");
        const sendsBack = action === "rejector changed to approve" || (action === "board reset" && jsonField(oldData, "status") === "BLOCKED");
        const subject = jsonField(newData, "subjectPersonId");
        if (subject === null) {
            const person = jsonField(oldData, "subjectPersonId");
            cleared.set(person, (cleared.get(person) ?? false) || sentBack || sendsBack);
            sentBack = false;
            current = undefined;
        } else if (action === "subject named") {
            sentBack = cleared.get(subject) ?? false;
            current = subject;
        } else if (sendsBack) sentBack = true;
    }
    const heldRejection = [...cleared].some(([person, held]) => held && person !== current);
    return { sentBack, heldRejection };
}

/** Whether a review's audit rows send it back for its current person (see rejectionHistory). */
export function sentBackForSubject(rows: readonly AuditFacts[]): boolean {
    return rejectionHistory(rows).sentBack;
}

export function jsonField(json: Prisma.JsonValue | null, key: string): Prisma.JsonValue | undefined {
    return json !== null && typeof json === "object" && !Array.isArray(json) ? json[key] : undefined;
}

/**
 * The reviews that make their person DISPUTED. A sent-back review stays disputing
 * through an undo of the changed approval; only a clearance (ACTIVE) ends it.
 */
export function disputingReviews(reviews: readonly CheckReviewFacts[]): CheckReviewFacts[] {
    return reviews.filter((r) => r.status === "BLOCKED" || (r.status === "PENDING_BG_REVIEW" && r.sentBack));
}

export function checkStanding(lastBackgroundCheck: Date | null, reviews: readonly CheckReviewFacts[], threshold: Date | null): CheckStanding {
    if (disputingReviews(reviews).length) return "DISPUTED";
    if (threshold && lastBackgroundCheck && lastBackgroundCheck.getTime() >= threshold.getTime()) return "CLEARED";
    if (reviews.some((r) => r.status === "PENDING_BG_REVIEW" && r.bgConsentAt)) return "PENDING";
    return "NONE";
}

/**
 * The household qualifies on its background check: at least one lead is
 * CLEARED, nobody in it is DISPUTED, and no review requested for it is waiting for
 * its first reviewer to name a person. Every member is read, not only adults: a
 * minor is never checked, so never holds a review to dispute.
 */
export function householdQualifies({ members, awaitingNaming }: { members: readonly { isHouseholdLead: boolean; standing: CheckStanding }[]; awaitingNaming: boolean }): boolean {
    return !awaitingNaming && members.some((m) => m.isHouseholdLead && m.standing === "CLEARED") && !members.some((m) => m.standing === "DISPUTED");
}

/** The earliest check date valid at the next membership-year boundary, from live board settings; null when the policy is unset. */
export async function liveBgThreshold(db: DbClient = prisma, now = new Date()): Promise<Date | null> {
    const settings = await db.boardSettings.findUnique({ where: { id: 1 }, select: { orgMembershipYearBoundary: true, bgRecheckMonths: true } });
    const boundary = settings?.orgMembershipYearBoundary ? nextBoundary(settings.orgMembershipYearBoundary, now) : null;
    return bgFreshThreshold(boundary, settings?.bgRecheckMonths);
}

/** Each open or blocked check review naming one of `personIds`, keyed by subject. */
export async function loadCheckReviews(db: DbClient, personIds: readonly number[]): Promise<Map<number, CheckReviewFacts[]>> {
    const byPerson = new Map<number, CheckReviewFacts[]>(personIds.map((id) => [id, []]));
    if (!personIds.length) return byPerson;
    const rows = await db.orgMembershipProcess.findMany({
        where: { kind: "PERSON_BG", subjectPersonId: { in: [...personIds] }, ...personBgOpen.where },
        select: { id: true, status: true, bgConsentAt: true, subjectPersonId: true },
    });
    const audits = rows.length
        ? await db.auditLog.findMany({
              where: { tableName: "OrgMembershipProcess", affectedEntityId: { in: rows.map((r) => r.id) } },
              orderBy: { id: "asc" },
              select: { affectedEntityId: true, oldData: true, newData: true },
          })
        : [];
    for (const r of rows) {
        const sentBack = sentBackForSubject(audits.filter((a) => a.affectedEntityId === r.id));
        byPerson.get(r.subjectPersonId!)?.push({ id: r.id, status: r.status, bgConsentAt: !!r.bgConsentAt, sentBack });
    }
    return byPerson;
}

/**
 * A household's members with their standing and the reviews disputing it, and
 * whether a review requested for it still names nobody.
 */
export async function householdCheckStandings(db: DbClient, householdId: number, threshold: Date | null) {
    const people = await db.person.findMany({ where: { householdId }, select: { id: true, isHouseholdLead: true, lastBackgroundCheck: true } });
    const reviews = await loadCheckReviews(db, people.map((m) => m.id));
    const members = people.map((m) => {
        const own = reviews.get(m.id) ?? [];
        return { personId: m.id, isHouseholdLead: m.isHouseholdLead, standing: checkStanding(m.lastBackgroundCheck, own, threshold), disputing: disputingReviews(own) };
    });
    const unnamed = await db.orgMembershipProcess.count({
        where: { kind: "PERSON_BG", requestedForHouseholdId: householdId, subjectPersonId: null, ...personBgOpen.where },
    });
    return { members, awaitingNaming: unnamed > 0 };
}

/** Whether anyone in the household holds a DISPUTED check standing; the window does not matter for a dispute. */
export async function householdHasDisputedCheck(db: DbClient, householdId: number): Promise<boolean> {
    const { members } = await householdCheckStandings(db, householdId, null);
    return members.some((m) => m.standing === "DISPUTED");
}

/**
 * Whether a check review still carries a rejection: sent back for its current person,
 * or left by a person a wrong-person reset cleared off it. Closing such a review would
 * erase that rejection.
 */
export async function reviewHoldsRejection(db: DbClient, processId: number): Promise<boolean> {
    const rows = await db.auditLog.findMany({
        where: { tableName: "OrgMembershipProcess", affectedEntityId: processId },
        orderBy: { id: "asc" },
        select: { oldData: true, newData: true },
    });
    const { sentBack, heldRejection } = rejectionHistory(rows);
    return sentBack || heldRejection;
}
