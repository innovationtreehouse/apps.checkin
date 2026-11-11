/**
 * @jest-environment node
 *
 * Nobody makes themself or a member of their own household a program lead, on
 * create or on edit. A program's lead approves its expense bucket.
 */

import { POST } from '@/app/api/programs/route';
import { PATCH } from '@/app/api/programs/[id]/route';
import prisma from '@/lib/prisma';
import { getServerSession } from 'next-auth/next';
import type { NextRequest } from 'next/server';
import { setMembershipYearBoundary } from '@/test-helpers/boardSettings';

jest.mock('next-auth/next', () => ({
    getServerSession: jest.fn(),
}));

const TAG = 'lead-self-assign-test';

describe('program lead assignment refuses self and own household', () => {
    // Program writes need the membership-year boundary.
    let restoreBoundary: () => Promise<void>;
    beforeAll(async () => { restoreBoundary = await setMembershipYearBoundary(); });
    afterAll(async () => { await restoreBoundary(); });

    let boardId: number;
    let housemateId: number;
    let outsiderId: number;
    let programId: number;
    const householdIds: number[] = [];

    const create = (leadMentorId: number) => POST(new Request('http://localhost/api/programs', {
        method: 'POST',
        body: JSON.stringify({ name: `${TAG} program`, leadMentorId, startAt: '2026-01-01', endAt: '2026-06-30', maxParticipants: 10 }),
    }) as unknown as NextRequest);

    const edit = (body: Record<string, unknown>) => PATCH(
        new Request(`http://localhost/api/programs/${programId}`, { method: 'PATCH', body: JSON.stringify(body) }) as unknown as NextRequest,
        { params: Promise.resolve({ id: String(programId) }) },
    );

    const currentLead = async () => (await prisma.program.findUniqueOrThrow({ where: { id: programId } })).leadMentorId;

    beforeAll(async () => {
        const board = await prisma.person.create({
            data: { email: `board-${TAG}@example.com`, name: 'Board', isBoardMember: true, isDeclaredAdult: true, household: { create: { name: TAG } } },
        });
        boardId = board.id;
        householdIds.push(board.householdId);

        const housemate = await prisma.person.create({
            data: { email: `housemate-${TAG}@example.com`, name: 'Housemate', isDeclaredAdult: true, householdId: board.householdId },
        });
        housemateId = housemate.id;

        const outsider = await prisma.person.create({
            data: { email: `outsider-${TAG}@example.com`, name: 'Outsider', isDeclaredAdult: true, household: { create: { name: TAG } } },
        });
        outsiderId = outsider.id;
        householdIds.push(outsider.householdId);

        const program = await prisma.program.create({
            data: { appliesToYear: 2026, name: `${TAG} existing`, startAt: new Date('2026-01-01'), endAt: new Date('2026-12-31'), leadMentorId: outsiderId },
        });
        programId = program.id;
    });

    beforeEach(() => {
        (getServerSession as jest.Mock).mockResolvedValue({ user: { id: boardId, isBoardMember: true } });
    });

    afterAll(async () => {
        const personIds = [boardId, housemateId, outsiderId];
        await prisma.program.deleteMany({ where: { name: { startsWith: TAG } } });
        await prisma.auditLog.deleteMany({ where: { actorId: { in: personIds } } });
        await prisma.person.deleteMany({ where: { id: { in: personIds } } });
        await prisma.household.deleteMany({ where: { id: { in: householdIds } } });
    });

    describe('POST /api/programs', () => {
        it('refuses the caller as lead', async () => {
            expect((await create(boardId)).status).toBe(403);
        });

        it("refuses a member of the caller's household as lead", async () => {
            expect((await create(housemateId)).status).toBe(403);
        });

        it('lets a board member make someone outside their household lead', async () => {
            const res = await create(outsiderId);
            expect(res.status).toBe(200);
            expect((await res.json()).program.leadMentorId).toBe(outsiderId);
        });
    });

    describe('PATCH /api/programs/[id]', () => {
        it('refuses the caller as lead', async () => {
            await prisma.program.update({ where: { id: programId }, data: { leadMentorId: outsiderId } });
            expect((await edit({ leadMentorId: boardId })).status).toBe(403);
            expect(await currentLead()).toBe(outsiderId);
        });

        it("refuses a member of the caller's household as lead", async () => {
            await prisma.program.update({ where: { id: programId }, data: { leadMentorId: outsiderId } });
            expect((await edit({ leadMentorId: housemateId })).status).toBe(403);
            expect(await currentLead()).toBe(outsiderId);
        });

        it('lets a board member make someone outside their household lead', async () => {
            await prisma.program.update({ where: { id: programId }, data: { leadMentorId: null } });
            expect((await edit({ leadMentorId: outsiderId })).status).toBe(200);
            expect(await currentLead()).toBe(outsiderId);
        });

        it('accepts the unchanged lead resent by an edit', async () => {
            await prisma.program.update({ where: { id: programId }, data: { leadMentorId: boardId } });
            expect((await edit({ leadMentorId: boardId, name: `${TAG} existing renamed` })).status).toBe(200);
            expect(await currentLead()).toBe(boardId);
        });
    });
});
