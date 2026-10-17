/**
 * @jest-environment node
 */
/**
 * Integration tests for the read-only Membership Compliance dashboard
 * (GET /api/membership-audit/compliance). Asserts each out-of-compliance
 * bucket surfaces with the right reason tag, a fresh ACTIVE household does not,
 * and a non-board user is forbidden.
 */

import { GET } from '@/app/api/membership-audit/compliance/route';
import prisma from '@/lib/prisma';
import { snapshotBoardSettings } from '@/test-helpers/boardSettings';
import { getServerSession } from 'next-auth/next';

jest.mock('next-auth/next', () => ({
    getServerSession: jest.fn(),
}));

const TAG = 'compliance-api-test';
const RECHECK_MONTHS = 12;

function get() {
    return GET(new Request('http://localhost:4000/api/membership-audit/compliance', {
        method: 'GET',
    }) as unknown as import('next/server').NextRequest);
}

/** Household with one lead person; optional lastBackgroundCheck on the lead. */
async function makeHousehold(slug: string, lastBackgroundCheck: Date | null) {
    const household = await prisma.household.create({ data: { name: `${TAG} ${slug}` } });
    const person = await prisma.person.create({
        data: {
            email: `${slug}-${TAG}@example.com`,
            name: `${slug} lead`,
            phone: '5551234567',
            householdId: household.id,
            lastBackgroundCheck,
        },
    });
    await prisma.person.update({ where: { id: person.id }, data: { isHouseholdLead: true } });
    return household.id;
}

describe('GET /api/membership-audit/compliance', () => {
    let boardId: number;
    let staleId: number;
    let freshId: number;
    let revokedId: number;
    let stuckId: number;
    let restoreBoardSettings: () => Promise<void> = async () => {};

    const cleanup = async () => {
        const hhs = await prisma.household.findMany({ where: { name: { contains: TAG } }, select: { id: true } });
        const hhIds = hhs.map(h => h.id);
        const ms = await prisma.orgMembership.findMany({ where: { householdId: { in: hhIds } }, select: { id: true } });
        await prisma.orgMembershipProcess.deleteMany({ where: { orgMembershipId: { in: ms.map(m => m.id) } } });
        await prisma.orgMembership.deleteMany({ where: { householdId: { in: hhIds } } });
        await prisma.person.deleteMany({ where: { OR: [{ email: { contains: TAG } }, { householdId: { in: hhIds } }] } });
        await prisma.household.deleteMany({ where: { id: { in: hhIds } } });
    };

    beforeAll(async () => {
        await cleanup();

        // Configure a real recheck window + boundary so the STALE_BG bucket is active.
        restoreBoardSettings = await snapshotBoardSettings();
        await prisma.boardSettings.upsert({
            where: { id: 1 },
            create: { id: 1, bgRecheckMonths: RECHECK_MONTHS, orgMembershipYearBoundary: new Date('2000-06-01') },
            update: { bgRecheckMonths: RECHECK_MONTHS, orgMembershipYearBoundary: new Date('2000-06-01') },
        });

        const board = await prisma.person.create({
            data: { email: `board-${TAG}@example.com`, name: 'Board Actor', isBoardMember: true, household: { create: { name: `${TAG} board` } } },
        });
        boardId = board.id;

        // ACTIVE + lead check 5 years old → STALE_BG.
        staleId = await makeHousehold('stale', new Date('2021-01-01'));
        await prisma.orgMembership.create({ data: { householdId: staleId, status: 'ACTIVE' } });

        // ACTIVE + lead check today → fresh, must NOT appear.
        freshId = await makeHousehold('fresh', new Date());
        await prisma.orgMembership.create({ data: { householdId: freshId, status: 'ACTIVE' } });

        // REVOKED membership.
        revokedId = await makeHousehold('revoked', new Date());
        await prisma.orgMembership.create({ data: { householdId: revokedId, status: 'REVOKED' } });

        // Process parked at PENDING_BG_CLEARANCE.
        stuckId = await makeHousehold('stuck', new Date());
        const stuckMembership = await prisma.orgMembership.create({ data: { householdId: stuckId, status: 'NONE' } });
        await prisma.orgMembershipProcess.create({
            data: { orgMembershipId: stuckMembership.id, kind: 'INITIAL', status: 'PENDING_BG_CLEARANCE' },
        });
    });

    afterAll(async () => {
        await cleanup();
        await restoreBoardSettings();
    });

    it('lists each out-of-compliance household with correct reason tags and excludes a fresh one', async () => {
        (getServerSession as jest.Mock).mockResolvedValue({ user: { id: boardId, isBoardMember: true } });

        const res = await get();
        expect(res.status).toBe(200);
        const { households } = await res.json();
        const byId = new Map<number, { reasons: string[]; lastBackgroundCheck: string | null }>(
            households.map((h: { id: number; reasons: string[]; lastBackgroundCheck: string | null }) => [h.id, h]),
        );

        expect(byId.get(staleId)?.reasons).toContain('STALE_BG');
        expect(byId.get(staleId)?.lastBackgroundCheck).not.toBeNull();
        expect(byId.get(revokedId)?.reasons).toContain('REVOKED');
        expect(byId.get(stuckId)?.reasons).toContain('STUCK_BG_CLEARANCE');
        expect(byId.has(freshId)).toBe(false);
    });

    it('forbids a non-board user', async () => {
        (getServerSession as jest.Mock).mockResolvedValue({ user: { id: boardId, isBoardMember: false } });
        const res = await get();
        expect(res.status).toBe(403);
    });

    it('rejects an anonymous caller', async () => {
        (getServerSession as jest.Mock).mockResolvedValue(null);
        const res = await get();
        expect(res.status).toBe(401);
    });
});
