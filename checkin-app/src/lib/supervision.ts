import type { Prisma } from "@/generated/prisma/client";
import prisma from "@/lib/prisma";
import type { DbClient } from "@/lib/db-client";
import { LIVE_PERSON } from "@/lib/person/filters";
import { personRecordIsActiveOrgMember } from "@/lib/orgMembership";
import { bgValidUntilBoundary } from "@/lib/membership/renewal";
import { isYouth, orgCalendarDay } from "@/lib/time";

/**
 * SUPERVISING ADULT — the single test behind both the departure interrupt
 * (#1436) and the two-deep compliance banner (#1550). Policy's "two deep" is two
 * *unrelated cleared volunteers*, not two bodies over 18, so counting bare adults
 * reports a room compliant when it is not (Definitions Policy, Art. III).
 *
 * A supervising adult is:
 *   - an adult (declared, or 18+ by date of birth; unknown age fails closed as
 *     youth, #300),
 *   - with a still-valid background clearance — the household's org membership is
 *     ACTIVE (ACTIVE is what encodes "background check cleared", see
 *     lib/orgMembership) AND their own `lastBackgroundCheck` has not expired under
 *     the board's recheck policy,
 *   - who holds no ACTIVE participant seat on a program that is in session now.
 *     A transition-year 18+ participant with a clearance is being supervised, not
 *     supervising; the same person counts later as a volunteer on another program.
 *
 * Two people from one household count as ONE, so the unit of counting is the
 * household, not the person.
 *
 * NOT part of the test: the volunteer-family fee flag, and school enrollment —
 * "student" here means program participant. Capturing school enrollment is #1442.
 */

/** Policy's two-deep floor. Below this the room is short of supervision. */
export const MIN_SUPERVISING_ADULTS = 2;

/**
 * A program is in session now: one of its events brackets this instant, or the
 * program's own dates cover today. An open-ended RUNNING program counts from its
 * start — an unset end date must not read as "not in session". A RUNNING program
 * with no start date either: `lte` never matches null, so without the fourth arm
 * its participants fail OPEN into the supervising count.
 */
function programInSessionNow(now: Date, today: Date): Prisma.ProgramWhereInput {
    return {
        OR: [
            { events: { some: { startAt: { lte: now }, endAt: { gte: now } } } },
            { startAt: { lte: today }, endAt: { gte: today } },
            { startAt: { lte: today }, phase: "RUNNING" },
        ],
    };
}

/**
 * Is this person's background clearance still valid today? Reuses the renewal
 * rule ({@link bgValidUntilBoundary}), which returns null when the board has set
 * no recheck policy — that means "never expires", not "expired". No check on file
 * is never valid: missing data fails closed, same as an unknown date of birth.
 */
function clearanceIsValid(
    lastBackgroundCheck: Date | null,
    settings: { orgMembershipYearBoundary: Date | null; bgRecheckMonths: number },
    today: Date,
): boolean {
    if (!lastBackgroundCheck) return false;
    const validUntil = bgValidUntilBoundary(lastBackgroundCheck, settings);
    return validUntil === null || validUntil.getTime() >= today.getTime();
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
    db: DbClient = prisma,
    now: Date = new Date(),
): Promise<Map<number, number>> {
    const today = orgCalendarDay(now);
    const settings = (await db.boardSettings.findUnique({
        where: { id: 1 },
        select: { orgMembershipYearBoundary: true, bgRecheckMonths: true },
    })) ?? { orgMembershipYearBoundary: null, bgRecheckMonths: 0 };

    const openVisits = await db.visit.findMany({
        where: { departedAt: null, deletedAt: null, person: LIVE_PERSON },
        select: {
            id: true,
            person: {
                select: {
                    householdId: true,
                    dateOfBirth: true,
                    isDeclaredAdult: true,
                    lastBackgroundCheck: true,
                    household: { select: { orgMembership: { select: { status: true } } } },
                    // Seat on a program in session now — one row is enough to exclude.
                    programParticipants: {
                        where: { status: "ACTIVE", program: programInSessionNow(now, today) },
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
        const isAdult = p.isDeclaredAdult || !isYouth(p.dateOfBirth, { unknownIs: "youth" });
        if (!isAdult) continue;
        if (!personRecordIsActiveOrgMember(p)) continue;
        if (!clearanceIsValid(p.lastBackgroundCheck, settings, today)) continue;
        if (p.programParticipants.length > 0) continue;
        supervising.set(visit.id, p.householdId);
    }
    return supervising;
}

/**
 * Is a youth in the building? The adult prong inverted, over the same open
 * visits: not declared adult, and not 18+ by date of birth — unknown age fails
 * closed as youth (#300). Only the `isDeclaredAdult` half is a query filter; the
 * age half stays with {@link isYouth} so the rule keeps one expression.
 */
export async function youthIsPresent(db: DbClient = prisma): Promise<boolean> {
    const candidates = await db.visit.findMany({
        where: { departedAt: null, deletedAt: null, person: { ...LIVE_PERSON, isDeclaredAdult: false } },
        select: { person: { select: { dateOfBirth: true } } },
    });
    return candidates.some(v => isYouth(v.person.dateOfBirth, { unknownIs: "youth" }));
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
