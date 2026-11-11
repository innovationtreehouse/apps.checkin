/**
 * @jest-environment node
 */
/**
 * Integration tests for GET /api/notifications — role-relevant in-app counts,
 * namespaced by domain (membership today).
 */

import { GET as NOTIFS } from '@/app/api/notifications/route';
import prisma from '@/lib/prisma';
import { getServerSession } from 'next-auth/next';

jest.mock('next-auth/next', () => ({ getServerSession: jest.fn() }));

const TAG = 'notif-test';

function as(id: number, roles: { isBackgroundCheckReviewer?: boolean; isBoardMember?: boolean; isSysadmin?: boolean } = {}) {
    (getServerSession as jest.Mock).mockResolvedValue({ user: { id, isSysadmin: false, isBoardMember: false, isBackgroundCheckReviewer: false, ...roles } });
}
const req = () => new Request('http://localhost:4000/x') as never;

describe('Membership notifications API', () => {
    let reviewerId: number, boardId: number, plainId: number;

    async function wipe() {
        const hhs = await prisma.household.findMany({ where: { OR: [{ name: { contains: TAG } }, { householdMembers: { some: { email: { contains: TAG } } } }] }, select: { id: true } });
        const ids = hhs.map((h) => h.id);
        if (ids.length) {
            await prisma.orgMembershipProcess.deleteMany({ where: { OR: [{ orgMembership: { householdId: { in: ids } } }, { requestedForHouseholdId: { in: ids } }] } });
            await prisma.orgMembership.deleteMany({ where: { householdId: { in: ids } } });
            await prisma.person.deleteMany({ where: { householdId: { in: ids } } });
            await prisma.household.deleteMany({ where: { id: { in: ids } } });
        }
        await prisma.person.deleteMany({ where: { email: { contains: TAG } } });
    }

    beforeAll(async () => {
        await wipe();
        reviewerId = (await prisma.person.create({ data: { email: `rev-${TAG}@example.com`, name: 'Rev', isBackgroundCheckReviewer: true, household: { create: { name: `Rev HH ${TAG}` } } } })).id;
        boardId = (await prisma.person.create({ data: { email: `board-${TAG}@example.com`, name: 'Board', isBoardMember: true, household: { create: { name: `Board HH ${TAG}` } } } })).id;
        plainId = (await prisma.person.create({ data: { email: `plain-${TAG}@example.com`, name: 'Plain', household: { create: { name: `Plain HH ${TAG}` } } } })).id;

        // A check review a household's consent opened, awaiting review (eligible for the reviewer — different household).
        const appHh = await prisma.household.create({ data: { name: `App HH ${TAG}` } });
        await prisma.person.create({ data: { name: 'App Lead', email: `applead-${TAG}@example.com`, householdId: appHh.id, isHouseholdLead: true } });
        await prisma.orgMembershipProcess.create({ data: { kind: 'PERSON_BG', requestedForHouseholdId: appHh.id, status: 'PENDING_BG_REVIEW', bgConsentAt: new Date() } });

        // A blocked application (for the board).
        const blkHh = await prisma.household.create({ data: { name: `Blk HH ${TAG}` } });
        const m2 = await prisma.orgMembership.create({ data: { householdId: blkHh.id, status: 'NONE' } });
        await prisma.orgMembershipProcess.create({ data: { orgMembershipId: m2.id, kind: 'INITIAL', status: 'BLOCKED' } });
    });

    afterAll(async () => {
        await wipe();
        await prisma.$disconnect();
    });

    it('a reviewer sees their pending review count', async () => {
        as(reviewerId, { isBackgroundCheckReviewer: true });
        const data = await (await NOTIFS(req())).json();
        expect(data.membership.pendingReviews).toBeGreaterThanOrEqual(1);
        expect(data.membership.blocked).toBe(0); // not board
    });

    it('a board member sees the blocked count and (as an implicit reviewer) pending reviews', async () => {
        as(boardId, { isBoardMember: true });
        const data = await (await NOTIFS(req())).json();
        expect(data.membership.blocked).toBeGreaterThanOrEqual(1);
        expect(data.membership.pendingReviews).toBeGreaterThanOrEqual(1); // board is an implicit reviewer
    });

    it('a plain user sees nothing', async () => {
        as(plainId);
        const data = await (await NOTIFS(req())).json();
        // Exact shape on purpose: a plain user must see every count at zero, and a
        // new board-only count added later must fail here until it's zeroed for them.
        expect(data).toEqual({
            membership: { pendingReviews: 0, blocked: 0, openPaymentExceptions: 0 },
            emergencyContacts: { householdsMissingValidContact: 0 },
        });
    });
});
