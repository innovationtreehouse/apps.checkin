/**
 * @jest-environment node
 */
/**
 * The "needs a lead" surfaces share lib/household/filters.ts: the broken-households
 * list, the membership-audit unclaimed list, and their nav badges. A household with
 * no members has nobody to promote, so it is not broken; the safety contact sheet
 * skips it too. Each list is asserted against its own badge count so they can't diverge.
 */
import { GET as BROKEN_GET } from '@/app/api/admin/broken-households/route';
import { GET as UNCLAIMED_GET } from '@/app/api/membership-audit/unclaimed-households/route';
import { GET as CONTACTS_GET } from '@/app/api/safety/emergency-contacts/route';
import { GET as TODO_GET } from '@/app/api/nav/todo-counts/route';
import prisma from '@/lib/prisma';
import { getServerSession } from 'next-auth/next';

jest.mock('next-auth/next', () => ({ getServerSession: jest.fn() }));
jest.mock('@/lib/config', () => {
    const actual = jest.requireActual('@/lib/config');
    return {
        __esModule: true,
        ...actual,
        config: { ...actual.config, nextAuthSecret: jest.fn(() => 'test-secret') },
    };
});

const TAG = 'lead-surfaces-hh-test';

function req() {
    return new Request('http://localhost:4000/x') as never;
}

async function json(res: Response) {
    return res.json();
}

async function cleanup() {
    await prisma.person.deleteMany({ where: { email: { contains: TAG } } });
    await prisma.household.deleteMany({ where: { name: { contains: TAG } } });
}

describe('household lead surfaces', () => {
    let keeperHh: number;
    let emptyHh: number;
    let brokenHh: number;
    let boardId: number;

    beforeAll(async () => {
        await cleanup();

        keeperHh = (await prisma.household.create({ data: { name: `Keeper ${TAG}` } })).id;
        const keeper = await prisma.person.create({
            data: { name: `Keeper ${TAG}`, email: `keeper-${TAG}@example.com`, householdId: keeperHh, isHouseholdLead: true },
        });
        // A claimed lead — keeps the keeper household off the unclaimed list.
        await prisma.account.create({
            data: { userId: keeper.id, type: 'oauth', provider: 'google', providerAccountId: `google-${TAG}` },
        });
        boardId = (await prisma.person.create({
            data: { name: `Board ${TAG}`, email: `board-${TAG}@example.com`, householdId: keeperHh, isBoardMember: true },
        })).id;

        emptyHh = (await prisma.household.create({ data: { name: `Empty ${TAG}` } })).id;

        // Broken: a member, no lead.
        brokenHh = (await prisma.household.create({ data: { name: `Broken ${TAG}` } })).id;
        await prisma.person.create({
            data: { name: `Live ${TAG}`, email: `live-${TAG}@example.com`, householdId: brokenHh },
        });

        (getServerSession as jest.Mock).mockResolvedValue({
            user: { id: boardId, email: `board-${TAG}@example.com`, householdId: keeperHh, isBoardMember: true, isSysadmin: false },
        });
    });

    afterAll(cleanup);

    it('GET /api/admin/broken-households lists the broken household, not the empty one', async () => {
        const { households } = await json(await BROKEN_GET(req()));
        const ids = households.map((h: { id: number }) => h.id);
        expect(ids).toContain(brokenHh);
        expect(ids).not.toContain(emptyHh);
        expect(ids).not.toContain(keeperHh);

        const broken = households.find((h: { id: number }) => h.id === brokenHh);
        expect(broken.members.map((m: { name: string }) => m.name)).toEqual([`Live ${TAG}`]);
    });

    it('GET /api/membership-audit/unclaimed-households lists the broken household, not the empty one', async () => {
        const { households } = await json(await UNCLAIMED_GET(req()));
        const ids = households.map((h: { id: number }) => h.id);
        expect(ids).toContain(brokenHh);
        expect(ids).not.toContain(emptyHh);
        expect(ids).not.toContain(keeperHh);

        const broken = households.find((h: { id: number }) => h.id === brokenHh);
        expect(broken.members).toEqual([
            { id: expect.any(Number), name: `Live ${TAG}`, email: `live-${TAG}@example.com` },
        ]);
    });

    it('GET /api/safety/emergency-contacts skips the empty household', async () => {
        const { households } = await json(await CONTACTS_GET(req()));
        const ids = households.map((h: { id: number }) => h.id);
        expect(ids).toContain(brokenHh);
        expect(ids).toContain(keeperHh);
        expect(ids).not.toContain(emptyHh);

        const broken = households.find((h: { id: number }) => h.id === brokenHh);
        expect(broken.householdMembers.map((m: { name: string }) => m.name)).toEqual([`Live ${TAG}`]);
    });

    it('nav badges match their lists (shared predicate, no drift)', async () => {
        const { admin } = await json(await TODO_GET(req()));
        const broken = await json(await BROKEN_GET(req()));
        const unclaimed = await json(await UNCLAIMED_GET(req()));

        expect(admin.brokenHouseholds).toBe(broken.households.length);
        expect(admin.unclaimedHouseholds).toBe(unclaimed.households.length);
    });
});
