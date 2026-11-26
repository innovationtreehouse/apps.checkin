import type { Prisma } from "@/generated/prisma/client";
import type { DbClient } from "@/lib/db-client";
import { personRecordIsActiveOrgMember } from "@/lib/orgMembership";
import { bgValidUntilBoundary } from "@/lib/membership/renewal";
import { isYouth } from "@/lib/time";

/**
 * SUPERVISING ADULT — the single test behind both the departure interrupt
 * and the two-deep compliance banner. Policy's "two deep" is two
 * *unrelated cleared volunteers*, not two bodies over 18, so counting bare adults
 * reports a room compliant when it is not (Definitions Policy, Art. III).
 *
 * A supervising adult is:
 *   - an adult (declared, or 18+ by date of birth; unknown age fails closed as
 *     youth),
 *   - with a still-valid background clearance — the household's org membership is
 *     ACTIVE (ACTIVE is what encodes "background check cleared", see
 *     lib/orgMembership) AND their own `lastBackgroundCheck` has not expired under
 *     the board's recheck policy,
 *   - who holds no ACTIVE participant seat on a program with a meeting under way
 *     now. A cleared 18+ participant is being supervised during their program's
 *     meeting, and counts like any volunteer outside it.
 *
 * Two people from one household count as ONE, so the unit of counting is the
 * household, not the person.
 *
 * NOT part of the test: the volunteer-family fee flag, and school enrollment —
 * "student" here means program participant.
 */

/** Policy's two-deep floor. Below this the room is short of supervision. */
export const MIN_SUPERVISING_ADULTS = 2;

/** A meeting of this program is under way now. Between meetings its participants supervise like anyone else. */
function programMeetingUnderWay(now: Date): Prisma.ProgramWhereInput {
    return { events: { some: { startAt: { lte: now }, endAt: { gte: now } } } };
}

/**
 * Is this person's background clearance still valid today? Reuses the renewal
 * rule ({@link bgValidUntilBoundary}). No check on file, no recheck policy, or no
 * membership-year boundary is never valid: missing data fails closed, same as an
 * unknown date of birth.
 */
function clearanceIsValid(
    lastBackgroundCheck: Date | null,
    settings: { orgMembershipYearBoundary: Date | null; bgRecheckMonths: number },
    today: Date,
): boolean {
    const validUntil = bgValidUntilBoundary(lastBackgroundCheck, settings);
    return validUntil !== null && validUntil.getTime() >= today.getTime();
}

/**
 * Every supervising adult currently in the building, as `visitId -> householdId`.
 *
 * Returning the mapping rather than a bare number is what lets the departure
 * interrupt ask both questions from ONE query: how many supervising adults are
 * here, and how many would remain if this visit ended. The household rule then
 * falls out for free — a second adult from the same household leaving does not
 * drop the count, because the household is still represented.
 */
export async function supervisingAdultVisits(
    db: DbClient,
    /** The org's calendar day, for age and clearance; `now` decides which meetings are under way. */
    today: Date,
    now: Date = new Date(),
): Promise<Map<number, number>> {
    const settings = (await db.boardSettings.findUnique({
        where: { id: 1 },
        select: { orgMembershipYearBoundary: true, bgRecheckMonths: true },
    })) ?? { orgMembershipYearBoundary: null, bgRecheckMonths: 0 };

    const openVisits = await db.visit.findMany({
        where: { departedAt: null, deletedAt: null },
        select: {
            id: true,
            person: {
                select: {
                    householdId: true,
                    dateOfBirth: true,
                    isDeclaredAdult: true,
                    lastBackgroundCheck: true,
                    household: { select: { orgMembership: { select: { status: true } } } },
                    // Seat on a program meeting now — one row is enough to exclude.
                    programParticipants: {
                        where: { status: "ACTIVE", program: programMeetingUnderWay(now) },
                        select: { programId: true },
                        take: 1,
                    },
                },
            },
        },
    });

    const supervising = new Map<number, number>();
    for (const visit of openVisits) {
        const p = visit.person;
        const isAdult = p.isDeclaredAdult || !isYouth(p.dateOfBirth, today, { unknownIs: "youth" });
        if (!isAdult) continue;
        if (!personRecordIsActiveOrgMember(p)) continue;
        if (!clearanceIsValid(p.lastBackgroundCheck, settings, today)) continue;
        if (p.programParticipants.length > 0) continue;
        supervising.set(visit.id, p.householdId);
    }
    return supervising;
}

/**
 * The youth among `present` with no adult of their own household present. An
 * adult covers their own household's youth whether or not they are cleared;
 * two-deep is owed only while this list is non-empty.
 */
export function uncoveredYouth<T extends { youth: boolean; householdId: number }>(present: T[]): T[] {
    const householdsWithAdult = new Set(present.filter(p => !p.youth).map(p => p.householdId));
    return present.filter(p => p.youth && !householdsWithAdult.has(p.householdId));
}

/** Every open visit, as the youth/household rows {@link uncoveredYouth} reads. Unknown age fails closed as youth. */
async function openPresence(db: DbClient, today: Date) {
    const open = await db.visit.findMany({
        where: { departedAt: null, deletedAt: null },
        select: { id: true, person: { select: { householdId: true, isDeclaredAdult: true, dateOfBirth: true } } },
    });
    return open.map(v => ({
        id: v.id,
        householdId: v.person.householdId,
        youth: !v.person.isDeclaredAdult && isYouth(v.person.dateOfBirth, today, { unknownIs: "youth" }),
    }));
}

/** Open visits of youth no adult of their own household covers ({@link uncoveredYouth}). */
export async function uncoveredYouthVisitIds(db: DbClient, today: Date): Promise<number[]> {
    return uncoveredYouth(await openPresence(db, today)).map(v => v.id);
}

/**
 * The uncovered youth now and as if `departingVisitId` had already ended, from
 * ONE read of the open visits so the two answers describe the same room.
 */
export async function uncoveredYouthAroundDeparture(
    db: DbClient,
    departingVisitId: number,
    today: Date,
): Promise<{ before: number[]; after: number[] }> {
    const present = await openPresence(db, today);
    return {
        before: uncoveredYouth(present).map(v => v.id),
        after: uncoveredYouth(present.filter(v => v.id !== departingVisitId)).map(v => v.id),
    };
}

/**
 * How many supervising adults the room has: distinct households, so a couple
 * counts once. Pass `excludeVisitId` to ask the same question as if that visit
 * had already ended — what the departure interrupt compares against.
 */
export function supervisingAdultCount(
    supervising: Map<number, number>,
    excludeVisitId?: number,
): number {
    const households = new Set<number>();
    for (const [visitId, householdId] of supervising) {
        if (visitId !== excludeVisitId) households.add(householdId);
    }
    return households.size;
}
