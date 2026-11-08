import type { DbClient } from "@/lib/db-client";
import prisma from "@/lib/prisma";
import { personBgOpen, type ProcessStatus } from "@/lib/membership/lifecycle";
import { bgFreshThreshold, nextBoundary } from "@/lib/membership/renewal";

/**
 * A person's background-check standing, derived from their own check reviews
 * (PERSON_BG rows naming them) and their `lastBackgroundCheck`
 * (docs/in-design/person-based-bg-review.md §3.1).
 *
 * - DISPUTED: a review is BLOCKED, or was Board-reset or changed to approve and has
 *   not cleared since. It beats CLEARED: an old clearance never outweighs a new
 *   rejection.
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
    /** A Board reset or a rejector's change to approve sent this review back. */
    sentBack: boolean;
};

/** Audit actions that send a review back for two new approvals (review.ts). */
export const SENT_BACK_ACTIONS = ["board reset", "rejector changed to approve"] as const;

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
 * The household qualifies on its background check (§3.2): at least one lead is
 * CLEARED, and nobody in it is DISPUTED. Every member is read, not only adults:
 * a minor is never checked, so never holds a review to dispute.
 */
export function householdQualifies(members: readonly { isHouseholdLead: boolean; standing: CheckStanding }[]): boolean {
    return members.some((m) => m.isHouseholdLead && m.standing === "CLEARED") && !members.some((m) => m.standing === "DISPUTED");
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
    const sentBack = new Set(
        rows.length
            ? (await db.auditLog.findMany({
                  where: {
                      tableName: "OrgMembershipProcess",
                      affectedEntityId: { in: rows.map((r) => r.id) },
                      OR: SENT_BACK_ACTIONS.map((action) => ({ newData: { path: ["action"], equals: action } })),
                  },
                  select: { affectedEntityId: true },
              })).map((a) => a.affectedEntityId)
            : [],
    );
    for (const r of rows) {
        byPerson.get(r.subjectPersonId!)?.push({ id: r.id, status: r.status, bgConsentAt: !!r.bgConsentAt, sentBack: sentBack.has(r.id) });
    }
    return byPerson;
}

/** A household's members with their standing and the reviews disputing it. */
export async function householdCheckStandings(db: DbClient, householdId: number, threshold: Date | null) {
    const members = await db.person.findMany({ where: { householdId }, select: { id: true, isHouseholdLead: true, lastBackgroundCheck: true } });
    const reviews = await loadCheckReviews(db, members.map((m) => m.id));
    return members.map((m) => {
        const own = reviews.get(m.id) ?? [];
        return { personId: m.id, isHouseholdLead: m.isHouseholdLead, standing: checkStanding(m.lastBackgroundCheck, own, threshold), disputing: disputingReviews(own) };
    });
}
