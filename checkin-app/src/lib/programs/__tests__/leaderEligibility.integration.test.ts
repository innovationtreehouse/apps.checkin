/**
 * @jest-environment node
 */
/**
 * A leader named mid-year is measured at the start of the program's membership
 * year, against a real database.
 */
import prisma from '@/lib/prisma';
import { programLeaderIneligibility } from '@/lib/programs/leaderEligibility';
import { liveMembershipYear, monthsBefore } from '@/lib/membership/renewal';
import { snapshotBoardSettings } from '@/test-helpers/boardSettings';

const TAG = 'leader-eligibility-it';
const RECHECK_MONTHS = 27;
const DAY = 86_400_000;

describe('programLeaderIneligibility, mid-year', () => {
    let restoreBoardSettings: () => Promise<void> = async () => {};
    // The year began 120 days ago, so today is mid-year, outside renewal season.
    const today = new Date();
    const yearStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()) - 120 * DAY);
    const year = liveMembershipYear(yearStart, today)!;

    async function wipe() {
        const hhs = await prisma.household.findMany({ where: { name: { contains: TAG } }, select: { id: true } });
        const ids = hhs.map((h) => h.id);
        await prisma.orgMembership.deleteMany({ where: { householdId: { in: ids } } });
        await prisma.person.deleteMany({ where: { householdId: { in: ids } } });
        await prisma.household.deleteMany({ where: { id: { in: ids } } });
    }

    async function memberCheckedOn(lastBackgroundCheck: Date) {
        const hh = await prisma.household.create({ data: { name: `Leader ${TAG}` } });
        await prisma.orgMembership.create({ data: { householdId: hh.id, status: 'ACTIVE' } });
        return prisma.person.create({ data: { name: `Leader ${TAG}`, householdId: hh.id, isHouseholdLead: true, lastBackgroundCheck } });
    }

    beforeAll(async () => {
        restoreBoardSettings = await snapshotBoardSettings();
        await prisma.boardSettings.upsert({
            where: { id: 1 },
            create: { id: 1, orgMembershipYearBoundary: yearStart, bgRecheckMonths: RECHECK_MONTHS },
            update: { orgMembershipYearBoundary: yearStart, bgRecheckMonths: RECHECK_MONTHS },
        });
        await wipe();
    });

    afterAll(async () => {
        await wipe();
        await restoreBoardSettings();
        await prisma.$disconnect();
    });

    it('is the year that began at the boundary just passed', () => {
        expect(year).toBe(yearStart.getUTCFullYear());
    });

    it('names a leader whose check is valid at the start of the year, though not at the next boundary', async () => {
        const leader = await memberCheckedOn(new Date(monthsBefore(yearStart, RECHECK_MONTHS).getTime() + 5 * DAY));
        expect(await programLeaderIneligibility(leader.id, leader, year)).toBeNull();
    });

    it('refuses a leader whose check had lapsed by the start of the year', async () => {
        const leader = await memberCheckedOn(new Date(monthsBefore(yearStart, RECHECK_MONTHS).getTime() - DAY));
        expect(await programLeaderIneligibility(leader.id, leader, year)).toMatch(/background-check clearance/);
    });
});
