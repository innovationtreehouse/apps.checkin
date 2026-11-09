import fs from 'fs';
import path from 'path';
import type { Prisma } from '@/generated/prisma/client';
import prisma from '@/lib/prisma';
import { liveMembershipYear } from '@/lib/membership/renewal';
import { membershipYearLabel } from '@/lib/programYear';

/** Runs the migration's own fill, extracted between its markers. */
const MIGRATION_SQL = path.join(
    __dirname,
    '../../../prisma/migrations/20261106100000_membership_year_fill_paid/migration.sql',
);
const TAG = `membership-year-paid-fill-${Date.now()}`;
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

const taggedWhere = { orgMembership: { household: { name: { startsWith: TAG } } } };

/** PR 4's count: rows that are, or a later step can make, settled with no year. */
async function rowsCoverageWouldMiss(): Promise<number> {
    return prisma.orgMembershipProcess.count({
        where: {
            ...taggedWhere,
            kind: { in: ['INITIAL', 'RENEWAL'] },
            appliesToYear: null,
            status: { not: 'ARCHIVED' },
            OR: [{ paidAt: { not: null } }, { status: 'ACTIVE', stageEnteredAt: { not: null } }],
        },
    });
}

describe('membership year fill for paid rows', () => {
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
        await prisma.orgMembershipProcess.deleteMany({ where: taggedWhere });
        await prisma.orgMembership.deleteMany({ where: { household: { name: { startsWith: TAG } } } });
        await prisma.household.deleteMany({ where: { name: { startsWith: TAG } } });
    });

    afterAll(async () => {
        await setBoundary(boundaryBefore);
    });

    it.each([
        ['September 1', Date.UTC(2026, 8, 1)],
        ['April 30', Date.UTC(2026, 3, 30)],
        ['January 1', Date.UTC(2026, 0, 1)],
    ])('places a paid BLOCKED row in the year the payment stamp records, every day of two years, boundary %s', async (_name, boundaryMs) => {
        const boundary = new Date(boundaryMs);
        const membershipId = await newMembership();
        await setBoundary(boundary);

        const moments: Date[] = [];
        for (let day = Date.UTC(2027, 0, 1); day < Date.UTC(2029, 0, 1); day += DAY_MS) {
            moments.push(new Date(day), new Date(day + DAY_MS - 1));
        }
        // stageEnteredAt sits years away, so a row placed by it would be wrong everywhere.
        await prisma.orgMembershipProcess.createMany({
            data: moments.map((paidAt) => ({
                orgMembershipId: membershipId,
                kind: 'RENEWAL' as const,
                status: 'BLOCKED' as const,
                stageEnteredAt: new Date(Date.UTC(2020, 5, 15)),
                paidAt,
            })),
        });

        await runFill();

        const rows = await prisma.orgMembershipProcess.findMany({ where: { orgMembershipId: membershipId } });
        expect(rows).toHaveLength(moments.length);
        const wrong = rows.filter((row) => row.appliesToYear !== liveMembershipYear(boundary, row.paidAt!));
        expect(wrong.map((row) => [row.paidAt, row.appliesToYear])).toEqual([]);
    });

    it('places by paidAt across the window start, not by stageEnteredAt', async () => {
        // Boundary September 1: the 2026 renewal window opens July 1.
        const stageEnteredAt = new Date(Date.UTC(2026, 9, 1));
        const before = await add({ kind: 'RENEWAL', status: 'BLOCKED', stageEnteredAt, paidAt: new Date(Date.UTC(2026, 6, 1) - 1) });
        const after = await add({ kind: 'RENEWAL', status: 'BLOCKED', stageEnteredAt, paidAt: new Date(Date.UTC(2026, 6, 1)) });

        await runFill();

        expect(await yearOf(before.id)).toBe(2025);
        expect(await yearOf(after.id)).toBe(2026);
    });

    it('credits a payment from the last two months to 2026-2027', async () => {
        const paidAt = new Date(Date.UTC(2026, 9, 15));
        const row = await add({ kind: 'INITIAL', status: 'PENDING_BG_REVIEW', stageEnteredAt: new Date(Date.UTC(2025, 4, 1)), paidAt });

        await runFill();

        const year = await yearOf(row.id);
        expect(year).not.toBeNull();
        expect(membershipYearLabel(year!)).toBe('2026-2027');
    });

    it('fills every paid joining and renewing row outside the archive, and no others', async () => {
        const stageEnteredAt = new Date(Date.UTC(2026, 2, 15));
        const paidAt = new Date(Date.UTC(2026, 7, 1));
        const bySettlement = [
            await add({ kind: 'INITIAL', status: 'ACTIVE', stageEnteredAt }),
            await add({ kind: 'RENEWAL', status: 'ACTIVE', stageEnteredAt, paidAt }),
            await add({ kind: 'RENEWAL', status: 'PENDING_BG_CLEARANCE', stageEnteredAt, paidAt }),
        ];
        const byPayment = [
            await add({ kind: 'INITIAL', status: 'BLOCKED', stageEnteredAt, paidAt }),
            await add({ kind: 'RENEWAL', status: 'BLOCKED', stageEnteredAt, paidAt }),
            await add({ kind: 'INITIAL', status: 'PENDING_BG_REVIEW', stageEnteredAt, paidAt }),
            await add({ kind: 'RENEWAL', status: 'PENDING_EXTERNAL_ACTION', stageEnteredAt, paidAt }),
            await add({ kind: 'RENEWAL', status: 'RENEWAL_PENDING_BG', stageEnteredAt, paidAt }),
            await add({ kind: 'INITIAL', status: 'PENDING_PAYMENT', stageEnteredAt, paidAt }),
            await add({ kind: 'RENEWAL', status: 'ACTIVE', stageEnteredAt: null, paidAt }),
        ];
        const empty = [
            await add({ kind: 'RENEWAL', status: 'ARCHIVED', stageEnteredAt, paidAt }),
            await add({ kind: 'RENEWAL', status: 'BLOCKED', stageEnteredAt }),
            await add({ kind: 'RENEWAL', status: 'PENDING_BG_REVIEW', stageEnteredAt }),
            await add({ kind: 'RENEWAL', status: 'ACTIVE', stageEnteredAt: null }),
            await add({ kind: 'PERSON_BG', status: 'BLOCKED', stageEnteredAt, paidAt }),
        ];

        await runFill();

        for (const row of bySettlement) expect(await yearOf(row.id)).toBe(2025);
        for (const row of byPayment) expect(await yearOf(row.id)).toBe(2026);
        for (const row of empty) expect(await yearOf(row.id)).toBeNull();
        expect(await rowsCoverageWouldMiss()).toBe(0);
    });

    it('keeps a recorded year, and a second run changes nothing', async () => {
        const stated = await add({ kind: 'RENEWAL', status: 'BLOCKED', stageEnteredAt: null, paidAt: new Date(Date.UTC(2026, 7, 1)), appliesToYear: 2023 });
        const empty = await add({ kind: 'RENEWAL', status: 'BLOCKED', stageEnteredAt: null, paidAt: new Date(Date.UTC(2026, 7, 1)) });

        await runFill();
        expect(await yearOf(stated.id)).toBe(2023);
        expect(await yearOf(empty.id)).toBe(2026);

        await setBoundary(new Date(Date.UTC(2026, 0, 1)));
        await runFill();
        expect(await yearOf(stated.id)).toBe(2023);
        expect(await yearOf(empty.id)).toBe(2026);
    });

    it('does nothing with no boundary set', async () => {
        const blocked = await add({ kind: 'RENEWAL', status: 'BLOCKED', stageEnteredAt: null, paidAt: new Date(Date.UTC(2026, 7, 1)) });
        const active = await add({ kind: 'RENEWAL', status: 'ACTIVE', stageEnteredAt: new Date(Date.UTC(2026, 2, 15)) });
        await setBoundary(null);

        await runFill();

        expect(await yearOf(blocked.id)).toBeNull();
        expect(await yearOf(active.id)).toBeNull();
    });
});
