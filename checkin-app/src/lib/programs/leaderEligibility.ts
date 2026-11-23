import type { DbClient } from "@/lib/db-client";
import prisma from "@/lib/prisma";
import { isActiveOrgMember } from "@/lib/orgMembership";
import { checkStanding, checkValidFor, loadCheckReviews, type CheckStanding } from "@/lib/membership/checkStanding";

/**
 * Why someone may not newly lead a program, or null when they may: a leader is in
 * an ACTIVE household membership and holds a background-check clearance valid at the
 * start of the program's membership year (`threshold`, null while the Board has set
 * no interval). Age is checked separately. The server check and the leader picker both
 * read this, so they cannot disagree.
 */
export function leaderIneligibilityReason(isActiveMember: boolean, standing: CheckStanding, threshold: Date | null): string | null {
    if (!threshold) return "The Board must set the background-check interval before a Program Leader can be named";
    if (!isActiveMember) return "Program Leader must be in an active Treehouse Membership";
    if (standing !== "CLEARED") return "Program Leader must have a current background-check clearance";
    return null;
}

/** leaderIneligibilityReason for one person leading a program of membership year `year`, read from the database. */
export async function programLeaderIneligibility(personId: number, person: { lastBackgroundCheck: Date | null }, year: number): Promise<string | null> {
    const threshold = await checkValidFor(year);
    const reviews = (await loadCheckReviews(prisma, [personId])).get(personId) ?? [];
    return leaderIneligibilityReason(await isActiveOrgMember(personId), checkStanding(person.lastBackgroundCheck, reviews, threshold), threshold);
}

export const LEADER_NEEDS_EMAIL = "A program leader needs an email on file. Add one first.";
export const LEADER_EMAIL_REQUIRED = "This person leads a program, so their email can't be removed. Name another leader first.";

/** True for an email value that leaves the person with no address: null, or blank. */
export function isBlankEmail(email: unknown): boolean {
    return email === null || (typeof email === "string" && email.trim() === "");
}

/** Leader notices go by email, so a person with none on file may not be newly named a program's leader. */
export function leaderEmailRefusal(person: { email: string | null }): string | null {
    return isBlankEmail(person.email) ? LEADER_NEEDS_EMAIL : null;
}

/** Whether any of `personIds` leads a program that hasn't finished. */
export async function leadsUnfinishedProgram(db: DbClient, personIds: readonly number[]): Promise<boolean> {
    if (!personIds.length) return false;
    return await db.program.count({ where: { leadMentorId: { in: [...personIds] }, phase: { not: "FINISHED" } } }) > 0;
}

/**
 * Why a save that writes `email` (undefined when the save leaves it alone) over `stored`
 * must be refused, or null: a sitting leader of an unfinished program keeps the address they have.
 */
export async function leaderEmailClearRefusal(db: DbClient, personId: number, email: unknown, stored: string | null): Promise<string | null> {
    if (email === undefined || !isBlankEmail(email) || isBlankEmail(stored)) return null;
    return await leadsUnfinishedProgram(db, [personId]) ? LEADER_EMAIL_REQUIRED : null;
}

/** leaderIneligibilityReason for each of `people` leading a program of membership year `year`, keyed by id, in two queries. */
export async function leaderIneligibilities(
    db: DbClient,
    people: readonly { id: number; isMember: boolean; lastBackgroundCheck: Date | null }[],
    year: number | null,
): Promise<Map<number, string | null>> {
    if (!people.length) return new Map();
    const [threshold, reviews] = await Promise.all([checkValidFor(year, db), loadCheckReviews(db, people.map((p) => p.id))]);
    return new Map(people.map((p) => [p.id, leaderIneligibilityReason(p.isMember, checkStanding(p.lastBackgroundCheck, reviews.get(p.id) ?? [], threshold), threshold)]));
}
