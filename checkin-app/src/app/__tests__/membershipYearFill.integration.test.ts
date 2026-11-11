import fs from 'fs';
import path from 'path';
import type { Prisma } from '@/generated/prisma/client';
import prisma from '@/lib/prisma';
import { membershipYearCycleForLabel } from '@/lib/membership/renewal';
import { membershipYearLabel } from '@/lib/programYear';

/** Runs the migration's own fill, extracted between its markers. */
const MIGRATION_SQL = path.join(
    __dirname,
    '../../../prisma/migrations/20261102130000_membership_year_fill/migration.sql',
);
const TAG = `membership-year-fill-${Date.now()}`;
const DAY_MS = 86_400_000;

async function runFill(): Promise<void> {
    const block = fs.readFileSync(MIGRATION_SQL, 'utf8').split('-- >>> FILL START')[1].split('-- >>> FILL END')[0];
    await prisma.$executeRawUnsafe(block.trim());
}

async function setBoundary(boundary: Date | null): Promise<void> {
    await prisma.boardSettings.upsert({
        where: { id: 1 },
        update: { orgMembershipYearBoundary: boundary },
        create: { id: 1, orgMembershipYearBoundary: boundary },
    });
}

async function newMembership(): Promise<number> {
    const household = await prisma.household.create({ data: { name: `${TAG} household` } });
    const membership = await prisma.orgMembership.create({ data: { householdId: household.id, status: 'ACTIVE' } });
    return membership.id;
}

/** The year the TypeScript rule places a moment in, from the windows on either side of it. */
function expectedYear(boundary: Date, at: Date): number {
    const year = at.getUTCFullYear();
    const matches = [year - 1, year, year + 1].filter((candidate) => {
        const cycle = membershipYearCycleForLabel(boundary, membershipYearLabel(candidate))!;
        return cycle.settledSince <= at && at < cycle.settledBefore;
    });
    expect(matches).toHaveLength(1);
    return matches[0];
}

describe('membership year fill', () => {
    let boundaryBefore: Date | null = null;
    // One membership per row: a membership holds only one in-flight application.
    const add = async (data: Omit<Prisma.OrgMembershipProcessUncheckedCreateInput, 'orgMembershipId'>) =>
        prisma.orgMembershipProcess.create({ data: { orgMembershipId: await newMembership(), ...data } });
    const yearOf = async (id: number) =>
        (await prisma.orgMembershipProcess.findUniqueOrThrow({ where: { id } })).appliesToYear;

    beforeAll(async () => {
        const settings = await prisma.boardSettings.findUnique({ where: { id: 1 } });
        boundaryBefore = settings?.orgMembershipYearBoundary ?? null;
    });

    beforeEach(async () => {
        await setBoundary(new Date(Date.UTC(2026, 8, 1)));
    });

    afterEach(async () => {
        const where = { orgMembership: { household: { name: { startsWith: TAG } } } };
        await prisma.orgMembershipProcess.deleteMany({ where });
        await prisma.orgMembership.deleteMany({ where: { household: { name: { startsWith: TAG } } } });
        await prisma.household.deleteMany({ where: { name: { startsWith: TAG } } });
    });

    afterAll(async () => {
        await setBoundary(boundaryBefore);
    });

    // April 30's window opens on March 2, past the short month; adding two months to a
    // date would place March 1 differently. January's window opens the calendar year before.
    it.each([
        ['September 1', Date.UTC(2026, 8, 1)],
        ['August 31', Date.UTC(2026, 7, 31)],
        ['April 30', Date.UTC(2026, 3, 30)],
        ['January 1', Date.UTC(2026, 0, 1)],
    ])('agrees with membershipYearCycleForLabel on every day of two years, boundary %s', async (_name, boundaryMs) => {
        const boundary = new Date(boundaryMs);
        const membershipId = await newMembership();
        await setBoundary(boundary);

        const moments: Date[] = [];
        for (let day = Date.UTC(2027, 0, 1); day < Date.UTC(2029, 0, 1); day += DAY_MS) {
            moments.push(new Date(day), new Date(day + DAY_MS - 1));
        }
        await prisma.orgMembershipProcess.createMany({
            data: moments.map((stageEnteredAt) => ({
                orgMembershipId: membershipId,
                kind: 'RENEWAL' as const,
                status: 'ACTIVE' as const,
                stageEnteredAt,
            })),
        });

        await runFill();

        const rows = await prisma.orgMembershipProcess.findMany({ where: { orgMembershipId: membershipId } });
        expect(rows).toHaveLength(moments.length);
        const wrong = rows.filter((row) => row.appliesToYear !== expectedYear(boundary, row.stageEnteredAt!));
        expect(wrong.map((row) => [row.stageEnteredAt, row.appliesToYear])).toEqual([]);
    });

    it('fills settled joining and renewing rows and no others', async () => {
        const stageEnteredAt = new Date(Date.UTC(2026, 2, 15));
        const paidAt = stageEnteredAt;
        const filled = [
            await add({ kind: 'INITIAL', status: 'ACTIVE', stageEnteredAt }),
            await add({ kind: 'RENEWAL', status: 'ACTIVE', stageEnteredAt }),
            await add({ kind: 'INITIAL', status: 'PENDING_BG_CLEARANCE', stageEnteredAt, paidAt }),
            await add({ kind: 'RENEWAL', status: 'PENDING_BG_CLEARANCE', stageEnteredAt, paidAt }),
        ];
        const empty = [
            await add({ kind: 'RENEWAL', status: 'ACTIVE', stageEnteredAt: null }),
            await add({ kind: 'RENEWAL', status: 'PENDING_BG_CLEARANCE', stageEnteredAt }),
            await add({ kind: 'RENEWAL', status: 'BLOCKED', stageEnteredAt, paidAt }),
            await add({ kind: 'RENEWAL', status: 'ARCHIVED', stageEnteredAt, paidAt }),
            await add({ kind: 'RENEWAL', status: 'PENDING_PAYMENT', stageEnteredAt }),
            await add({ kind: 'PERSON_BG', status: 'ACTIVE', stageEnteredAt }),
        ];

        await runFill();

        for (const row of filled) expect(await yearOf(row.id)).toBe(2025);
        for (const row of empty) expect(await yearOf(row.id)).toBeNull();
    });

    it('keeps a recorded year, and a second run changes nothing', async () => {
        const stated = await add({ kind: 'RENEWAL', status: 'ACTIVE', stageEnteredAt: new Date(Date.UTC(2026, 2, 15)), appliesToYear: 2023 });
        const empty = await add({ kind: 'RENEWAL', status: 'ACTIVE', stageEnteredAt: new Date(Date.UTC(2026, 6, 1)) });

        await runFill();
        expect(await yearOf(stated.id)).toBe(2023);
        expect(await yearOf(empty.id)).toBe(2026);

        await setBoundary(new Date(Date.UTC(2026, 0, 1)));
        await runFill();
        expect(await yearOf(stated.id)).toBe(2023);
        expect(await yearOf(empty.id)).toBe(2026);
    });

    it('does nothing with no boundary set', async () => {
        const row = await add({ kind: 'RENEWAL', status: 'ACTIVE', stageEnteredAt: new Date(Date.UTC(2026, 2, 15)) });
        await setBoundary(null);

        await runFill();

        expect(await yearOf(row.id)).toBeNull();
    });
});
