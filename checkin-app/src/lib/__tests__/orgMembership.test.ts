/**
 * @jest-environment node
 */
/**
 * Unit tests for the membership-duration guard added to lib/orgMembership.ts:
 *   - membershipValidThrough: a household's covered-through boundary — the
 *     boundary closing the live membership year once the household settled for
 *     it, else the boundary that opened it (same probe as the households-ops
 *     list's settledForComingYear / validUntil).
 *   - isActiveOrgMemberThrough: does a person's membership cover a program
 *     running through a given date.
 *   - programCoverageDate: the date a program's member pricing must be valid
 *     through (endAt, else startAt, else null).
 * Prisma mocked — no DB. nextBoundary/renewalSeasonWindow run for real (from
 * @/lib/membership/renewal) so the boundary arithmetic is exercised, not stubbed.
 */
import {
    membershipValidThrough,
    isActiveOrgMemberThrough,
    isDuesSettled,
    isDuesSettledThrough,
    ACTIVE_ORG_MEMBER_PERSON_WHERE,
    DUES_SETTLED_PERSON_WHERE,
    programCoverageDate,
} from '@/lib/orgMembership';
import { nextBoundary, membershipYearCycle, coveredThrough } from '@/lib/membership/renewal';

jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    default: {
        household: { findUnique: jest.fn() },
        boardSettings: { findUnique: jest.fn() },
        orgMembershipProcess: { findFirst: jest.fn() },
        person: { findFirst: jest.fn(), findUnique: jest.fn() },
    },
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const prisma = require('@/lib/prisma').default;

const BOUNDARY = new Date(Date.UTC(2000, 11, 25)); // Dec 25 — mirrors the repo's other boundary tests
// Long before any live year's window: membership age alone never settles these households.
const OLD_MEMBER_SINCE = new Date(Date.UTC(2020, 0, 1));
const ACTIVE_HH = { orgMembership: { id: 7, status: 'ACTIVE', memberSince: OLD_MEMBER_SINCE } };

beforeEach(() => jest.clearAllMocks());

describe('membershipValidThrough', () => {
    it('in season, not settled → the upcoming boundary (the live year has not started)', async () => {
        prisma.household.findUnique.mockResolvedValue(ACTIVE_HH);
        prisma.boardSettings.findUnique.mockResolvedValue({ orgMembershipYearBoundary: BOUNDARY });
        prisma.orgMembershipProcess.findFirst.mockResolvedValue(null); // not settled

        const now = new Date(Date.UTC(2026, 10, 1)); // Nov 1: inside the 2-month window before Dec 25
        const result = await membershipValidThrough(1, now);
        expect(result).toEqual(nextBoundary(BOUNDARY, now));
    });

    it('in season, settled → one year past the upcoming boundary', async () => {
        prisma.household.findUnique.mockResolvedValue(ACTIVE_HH);
        prisma.boardSettings.findUnique.mockResolvedValue({ orgMembershipYearBoundary: BOUNDARY });
        prisma.orgMembershipProcess.findFirst.mockResolvedValue({ id: 99 }); // settled

        const now = new Date(Date.UTC(2026, 10, 1));
        const result = await membershipValidThrough(1, now);
        const boundary = nextBoundary(BOUNDARY, now);
        expect(result).toEqual(new Date(Date.UTC(boundary.getUTCFullYear() + 1, boundary.getUTCMonth(), boundary.getUTCDate())));
    });

    it('after the boundary, not settled → the boundary just passed (lapsed), not next year\'s', async () => {
        prisma.household.findUnique.mockResolvedValue(ACTIVE_HH);
        prisma.boardSettings.findUnique.mockResolvedValue({ orgMembershipYearBoundary: BOUNDARY });
        prisma.orgMembershipProcess.findFirst.mockResolvedValue(null);

        const now = new Date(Date.UTC(2027, 0, 10)); // Jan 10: twelve days past the Dec 25 boundary
        expect(await membershipValidThrough(1, now)).toEqual(new Date(Date.UTC(2026, 11, 25)));
    });

    it('after the boundary, settled in the window that preceded it → the next boundary', async () => {
        prisma.household.findUnique.mockResolvedValue(ACTIVE_HH);
        prisma.boardSettings.findUnique.mockResolvedValue({ orgMembershipYearBoundary: BOUNDARY });
        prisma.orgMembershipProcess.findFirst.mockResolvedValue({ id: 99 });

        const now = new Date(Date.UTC(2027, 0, 10));
        expect(await membershipValidThrough(1, now)).toEqual(new Date(Date.UTC(2027, 11, 25)));
        // The probe asks since the live year's window opened (Oct 25 2026), not "never".
        const where = prisma.orgMembershipProcess.findFirst.mock.calls[0][0].where;
        expect(where.stageEnteredAt).toEqual({ gte: new Date(Date.UTC(2026, 9, 25)) });
    });

    it('a membership with no dues-paid process is not settled, however recently it began (bare manual grant)', async () => {
        prisma.household.findUnique.mockResolvedValue({ orgMembership: { id: 7, status: 'ACTIVE', memberSince: new Date(Date.UTC(2026, 11, 1)) } });
        prisma.boardSettings.findUnique.mockResolvedValue({ orgMembershipYearBoundary: BOUNDARY });
        prisma.orgMembershipProcess.findFirst.mockResolvedValue(null);

        expect(await membershipValidThrough(1, new Date(Date.UTC(2027, 0, 10)))).toEqual(new Date(Date.UTC(2026, 11, 25)));
    });

    it('the settled probe is kind-agnostic — a new family joining in-window counts, not only a RENEWAL', async () => {
        prisma.household.findUnique.mockResolvedValue(ACTIVE_HH);
        prisma.boardSettings.findUnique.mockResolvedValue({ orgMembershipYearBoundary: BOUNDARY });
        prisma.orgMembershipProcess.findFirst.mockResolvedValue({ id: 99 });

        await membershipValidThrough(1, new Date(Date.UTC(2026, 0, 1)));
        const where = prisma.orgMembershipProcess.findFirst.mock.calls[0][0].where;
        expect(where).not.toHaveProperty('kind');
        // ACTIVE or paid-awaiting-clearance; ARCHIVED never paid — must not extend.
        expect(where.OR).toEqual([{ status: 'ACTIVE' }, { status: { in: ['PENDING_BG_CLEARANCE'] }, paidAt: { not: null } }]);
    });

    it('not ACTIVE → null', async () => {
        prisma.household.findUnique.mockResolvedValue({ orgMembership: { id: 7, status: 'REVOKED', memberSince: OLD_MEMBER_SINCE } });
        const result = await membershipValidThrough(1, new Date());
        expect(result).toBeNull();
        expect(prisma.boardSettings.findUnique).not.toHaveBeenCalled();
    });

    it('no boundary configured → null', async () => {
        prisma.household.findUnique.mockResolvedValue(ACTIVE_HH);
        prisma.boardSettings.findUnique.mockResolvedValue({ orgMembershipYearBoundary: null });
        const result = await membershipValidThrough(1, new Date());
        expect(result).toBeNull();
    });
});

describe('isActiveOrgMemberThrough', () => {
    it('not an active member → false, regardless of through', async () => {
        prisma.person.findFirst.mockResolvedValue(null); // isActiveOrgMember: no match
        const result = await isActiveOrgMemberThrough(1, new Date());
        expect(result).toBe(false);
    });

    it('through === null → true (status-only, no program dates)', async () => {
        prisma.person.findFirst.mockResolvedValue({ id: 1 }); // active member
        const result = await isActiveOrgMemberThrough(1, null);
        expect(result).toBe(true);
    });

    it('ACTIVE + no boundary configured → true (cannot compute a horizon)', async () => {
        prisma.person.findFirst.mockResolvedValue({ id: 1 });
        prisma.person.findUnique.mockResolvedValue({ householdId: 5 });
        prisma.household.findUnique.mockResolvedValue(ACTIVE_HH);
        prisma.boardSettings.findUnique.mockResolvedValue({ orgMembershipYearBoundary: null });

        const result = await isActiveOrgMemberThrough(1, new Date(Date.UTC(2030, 0, 1)));
        expect(result).toBe(true);
    });

    it('a through-date on the valid-through day → true', async () => {
        prisma.person.findFirst.mockResolvedValue({ id: 1 });
        prisma.person.findUnique.mockResolvedValue({ householdId: 5 });
        prisma.household.findUnique.mockResolvedValue(ACTIVE_HH);
        prisma.boardSettings.findUnique.mockResolvedValue({ orgMembershipYearBoundary: BOUNDARY });
        prisma.orgMembershipProcess.findFirst.mockResolvedValue(null);

        const validThrough = coveredThrough(membershipYearCycle(BOUNDARY, new Date()), false);
        const result = await isActiveOrgMemberThrough(1, validThrough);
        expect(result).toBe(true);
    });

    it('a through-date after the valid-through day → false', async () => {
        prisma.person.findFirst.mockResolvedValue({ id: 1 });
        prisma.person.findUnique.mockResolvedValue({ householdId: 5 });
        prisma.household.findUnique.mockResolvedValue(ACTIVE_HH);
        prisma.boardSettings.findUnique.mockResolvedValue({ orgMembershipYearBoundary: BOUNDARY });
        prisma.orgMembershipProcess.findFirst.mockResolvedValue(null);

        const validThrough = coveredThrough(membershipYearCycle(BOUNDARY, new Date()), false);
        const dayAfter = new Date(Date.UTC(validThrough.getUTCFullYear(), validThrough.getUTCMonth(), validThrough.getUTCDate() + 1));
        const result = await isActiveOrgMemberThrough(1, dayAfter);
        expect(result).toBe(false);
    });
});

// #1397: a household that has paid its dues but is still waiting on background
// clearance gets the MEMBER rate and members-only programs. The widening is
// program-scoped — every other "is this a member?" question stays ACTIVE-only.
describe('program access for a paid, not-yet-cleared household', () => {
    const PAID_PENDING = { orgMembership: { id: 7, status: 'NONE', memberSince: OLD_MEMBER_SINCE, processes: [{ id: 3 }] } };

    it('DUES_SETTLED_PERSON_WHERE admits ACTIVE and paid-pending-clearance; ACTIVE_ORG_MEMBER_PERSON_WHERE admits only ACTIVE', () => {
        expect(DUES_SETTLED_PERSON_WHERE).toEqual({
            household: {
                orgMembership: {
                    OR: [
                        { status: 'ACTIVE' },
                        { processes: { some: { status: { in: ['PENDING_BG_CLEARANCE'] }, paidAt: { not: null } } } },
                    ],
                },
            },
        });
        expect(ACTIVE_ORG_MEMBER_PERSON_WHERE).toEqual({ household: { orgMembership: { status: 'ACTIVE' } } });
    });

    it('isDuesSettled queries with the pricing predicate, not the ACTIVE one', async () => {
        prisma.person.findFirst.mockResolvedValue({ id: 1 });
        expect(await isDuesSettled(1)).toBe(true);
        expect(prisma.person.findFirst).toHaveBeenCalledWith(
            expect.objectContaining({ where: { AND: [{ id: 1 }, DUES_SETTLED_PERSON_WHERE] } }),
        );
    });

    it('membershipValidThrough gives a paid-pending household the same horizon rule as an ACTIVE one', async () => {
        prisma.household.findUnique.mockResolvedValue(PAID_PENDING);
        prisma.boardSettings.findUnique.mockResolvedValue({ orgMembershipYearBoundary: BOUNDARY });
        prisma.orgMembershipProcess.findFirst.mockResolvedValue(null);

        const now = new Date(Date.UTC(2026, 0, 1));
        expect(await membershipValidThrough(1, now)).toEqual(coveredThrough(membershipYearCycle(BOUNDARY, now), false));
    });

    it('isDuesSettledThrough honours the same coverage window as an ACTIVE member', async () => {
        prisma.person.findFirst.mockResolvedValue({ id: 1 });
        prisma.person.findUnique.mockResolvedValue({ householdId: 5 });
        prisma.household.findUnique.mockResolvedValue(PAID_PENDING);
        prisma.boardSettings.findUnique.mockResolvedValue({ orgMembershipYearBoundary: BOUNDARY });
        prisma.orgMembershipProcess.findFirst.mockResolvedValue(null);

        const validThrough = coveredThrough(membershipYearCycle(BOUNDARY, new Date()), false);
        const dayAfter = new Date(Date.UTC(validThrough.getUTCFullYear(), validThrough.getUTCMonth(), validThrough.getUTCDate() + 1));
        expect(await isDuesSettledThrough(1, validThrough)).toBe(true);
        expect(await isDuesSettledThrough(1, dayAfter)).toBe(false);
    });

    it('a household with neither ACTIVE nor a paid-pending process still gets no horizon', async () => {
        prisma.household.findUnique.mockResolvedValue({ orgMembership: { id: 7, status: 'NONE', memberSince: OLD_MEMBER_SINCE, processes: [] } });
        expect(await membershipValidThrough(1, new Date())).toBeNull();
        expect(prisma.boardSettings.findUnique).not.toHaveBeenCalled();
    });
});

// coversThrough (private, exercised here via isDuesSettledThrough) deliberately
// fails OPEN when a coverage horizon can't be computed: a dues-settled
// household still gets member pricing even though the board hasn't configured
// orgMembershipYearBoundary, rather than losing member pricing for a settings gap.
describe('isDuesSettledThrough fail-open when no coverage horizon is configured', () => {
    it('dues-settled household + no board-configured boundary → covers any through-date', async () => {
        prisma.person.findFirst.mockResolvedValue({ id: 1 }); // dues settled
        prisma.person.findUnique.mockResolvedValue({ householdId: 5 });
        prisma.household.findUnique.mockResolvedValue(ACTIVE_HH);
        prisma.boardSettings.findUnique.mockResolvedValue({ orgMembershipYearBoundary: null });

        const farFuture = new Date(Date.UTC(2099, 0, 1));
        expect(await isDuesSettledThrough(1, farFuture)).toBe(true);
    });

    it('a program with no coverage date (through === null) → status alone decides', async () => {
        prisma.person.findFirst.mockResolvedValue({ id: 1 }); // dues settled
        expect(await isDuesSettledThrough(1, null)).toBe(true);
    });
});

describe('programCoverageDate', () => {
    it('returns endAt', () => {
        const endAt = new Date('2026-06-01');
        expect(programCoverageDate({ endAt })).toBe(endAt);
    });
});
