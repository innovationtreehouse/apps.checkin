import type { DbClient } from "@/lib/db-client";
import prisma from "@/lib/prisma";
import { isActiveOrgMember } from "@/lib/orgMembership";
import { checkStanding, liveBgThreshold, loadCheckReviews, type CheckStanding } from "@/lib/membership/checkStanding";

/**
 * Why someone may not newly lead a program, or null when they may: a leader is in
 * an ACTIVE household membership and holds a background-check clearance valid at the
 * next membership-year boundary (`threshold`, null while the Board has set no
 * interval). Age is checked separately. The server check and the leader picker both
 * read this, so they cannot disagree.
 */
export function leaderIneligibilityReason(isActiveMember: boolean, standing: CheckStanding, threshold: Date | null): string | null {
    if (!threshold) return "The Board must set the background-check interval before a Program Leader can be named";
    if (!isActiveMember) return "Program Leader must be in an active Treehouse Membership";
    if (standing !== "CLEARED") return "Program Leader must have a current background-check clearance";
    return null;
}

/** leaderIneligibilityReason for one person, read from the database. */
export async function programLeaderIneligibility(personId: number, person: { lastBackgroundCheck: Date | null }): Promise<string | null> {
    const threshold = await liveBgThreshold();
    const reviews = (await loadCheckReviews(prisma, [personId])).get(personId) ?? [];
    return leaderIneligibilityReason(await isActiveOrgMember(personId), checkStanding(person.lastBackgroundCheck, reviews, threshold), threshold);
}

/** leaderIneligibilityReason for each of `people`, keyed by id, in two queries. */
export async function leaderIneligibilities(
    db: DbClient,
    people: readonly { id: number; isMember: boolean; lastBackgroundCheck: Date | null }[],
): Promise<Map<number, string | null>> {
    if (!people.length) return new Map();
    const [threshold, reviews] = await Promise.all([liveBgThreshold(db), loadCheckReviews(db, people.map((p) => p.id))]);
    return new Map(people.map((p) => [p.id, leaderIneligibilityReason(p.isMember, checkStanding(p.lastBackgroundCheck, reviews.get(p.id) ?? [], threshold), threshold)]));
}
