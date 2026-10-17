/**
 * @jest-environment node
 */
/**
 * A merged-away Person keeps its householdId and loses isHouseholdLead, so a
 * household whose only remaining member is a tombstone reads as "has members,
 * no lead" — it lands on every board "needs a lead" surface with nothing to
 * promote, and its tombstone's name renders on the keyholder contact sheet.
 *
 * Covers the four surfaces that share those predicates: the broken-households
 * list, the membership-audit unclaimed list, the safety contact sheet, and the
 * two nav badges — asserting each list against its own badge count, since
 * lib/household/filters.ts exists precisely so they can't diverge.
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

const TAG = 'tombstone-hh-test';

function req() {
    return new Request('http://localhost:4000/x') as never;
}

async function json(res: Response) {
    return res.json();
}

async function cleanup() {
    await prisma.person.updateMany({ where: { email: { contains: TAG } }, data: { mergedIntoId: null } });
    await prisma.person.deleteMany({ where: { email: { contains: TAG } } });
    await prisma.household.deleteMany({ where: { name: { contains: TAG } } });
}

describe('live-empty households (only member is a merge tombstone)', () => {
    let keeperHh: number;
    let ghostHh: number;
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

        // Live-empty: its one member was merged away (merge clears isHouseholdLead).
        ghostHh = (await prisma.household.create({ data: { name: `Ghost ${TAG}` } })).id;
        await prisma.person.create({
            data: { name: `Ghost ${TAG}`, email: `ghost-${TAG}@example.com`, householdId: ghostHh, mergedIntoId: keeper.id },
        });

        // Genuinely broken: a live member, no lead — plus a tombstone that must not render.
        brokenHh = (await prisma.household.create({ data: { name: `Broken ${TAG}` } })).id;
        await prisma.person.create({
            data: { name: `Live ${TAG}`, email: `live-${TAG}@example.com`, householdId: brokenHh },
        });
        await prisma.person.create({
            data: { name: `Ghost2 ${TAG}`, email: `ghost2-${TAG}@example.com`, householdId: brokenHh, mergedIntoId: keeper.id },
        });

        (getServerSession as jest.Mock).mockResolvedValue({
            user: { id: boardId, email: `board-${TAG}@example.com`, householdId: keeperHh, isBoardMember: true, isSysadmin: false },
        });
    });

    afterAll(cleanup);

    it('GET /api/admin/broken-households skips it and hides the tombstone in the broken household', async () => {
        const { households } = await json(await BROKEN_GET(req()));
        const ids = households.map((h: { id: number }) => h.id);
        expect(ids).toContain(brokenHh);
        expect(ids).not.toContain(ghostHh);
        expect(ids).not.toContain(keeperHh);

        const broken = households.find((h: { id: number }) => h.id === brokenHh);
        expect(broken.members.map((m: { name: string }) => m.name)).toEqual([`Live ${TAG}`]);
    });

    it('GET /api/membership-audit/unclaimed-households skips it and hides the tombstone', async () => {
        const { households } = await json(await UNCLAIMED_GET(req()));
        const ids = households.map((h: { id: number }) => h.id);
        expect(ids).toContain(brokenHh);
        expect(ids).not.toContain(ghostHh);
        expect(ids).not.toContain(keeperHh);

        // This list names people to chase, so a tombstone's name and its rewritten
        // address must not be offered as a contact.
        const broken = households.find((h: { id: number }) => h.id === brokenHh);
        expect(broken.members).toEqual([
            { id: expect.any(Number), name: `Live ${TAG}`, email: `live-${TAG}@example.com` },
        ]);
    });

    it('GET /api/safety/emergency-contacts skips it and hides the tombstone', async () => {
        const { households } = await json(await CONTACTS_GET(req()));
        const ids = households.map((h: { id: number }) => h.id);
        expect(ids).toContain(brokenHh);
        expect(ids).toContain(keeperHh);
        expect(ids).not.toContain(ghostHh);

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
