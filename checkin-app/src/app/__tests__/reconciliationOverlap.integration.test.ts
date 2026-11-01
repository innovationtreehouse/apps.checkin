/**
 * @jest-environment node
 */
/**
 * Website visit writes against the person's other visits: overlapping an open
 * visit is refused, overlapping a closed one is applied and flagged. Also the
 * "closed out by a close" filter on the visits screen.
 */
import { GET, PATCH as staffEdit } from '@/app/api/facility/visits/route';
import { POST as staffInsert } from '@/app/api/facility/visits/insert/route';
import { POST as memberInsert } from '@/app/api/attendance/manual/route';
import { PATCH as memberEdit } from '@/app/api/attendance/manual/[id]/route';
import prisma from '@/lib/prisma';
import { getServerSession } from 'next-auth/next';
import type { NextRequest } from 'next/server';

jest.mock('next-auth/next', () => ({ getServerSession: jest.fn() }));

const TAG = 'reconciliation-overlap-test';
const MIN = 60_000;
const ago = (minutes: number) => new Date(Date.now() - minutes * MIN);
const request = (url: string, method: string, body?: unknown) =>
    new Request(`http://localhost${url}`, { method, ...(body ? { body: JSON.stringify(body) } : {}) }) as unknown as NextRequest;
const noParams = { params: Promise.resolve({}) };

describe('reconciliation overlap check', () => {
    let boardId: number;
    let memberId: number;
    let householdIds: number[];

    beforeAll(async () => {
        const [board, member] = await Promise.all([
            prisma.person.create({ data: { name: 'Board', email: `board-${TAG}@example.com`, isBoardMember: true, household: { create: { name: 'Test HH' } } } }),
            prisma.person.create({ data: { name: 'Member', email: `member-${TAG}@example.com`, household: { create: { name: 'Test HH' } } } }),
        ]);
        boardId = board.id;
        memberId = member.id;
        householdIds = [board.householdId, member.householdId];
    });

    afterEach(async () => {
        await prisma.auditLog.deleteMany({ where: { secondaryAffectedEntity: memberId } });
        await prisma.visit.deleteMany({ where: { personId: memberId } });
        await prisma.facilityClose.deleteMany({ where: { closedById: boardId } });
    });

    afterAll(async () => {
        await prisma.auditLog.deleteMany({ where: { actorId: { in: [boardId, memberId] } } });
        await prisma.person.deleteMany({ where: { id: { in: [boardId, memberId] } } });
        await prisma.household.deleteMany({ where: { id: { in: householdIds } } });
    });

    const signInAs = (id: number, extra: Record<string, unknown> = {}) =>
        (getServerSession as jest.Mock).mockResolvedValue({ user: { id, ...extra } });
    const asBoard = () => signInAs(boardId, { isBoardMember: true });
    const asMember = () => signInAs(memberId);
    const openVisit = () => prisma.visit.create({ data: { personId: memberId, arrivedAt: ago(30), arrivedVia: 'SCANNER' } });
    const closedVisit = (from: number, to: number) =>
        prisma.visit.create({ data: { personId: memberId, arrivedAt: ago(from), departedAt: ago(to), arrivedVia: 'SCANNER', departedVia: 'SCANNER' } });
    const auditOf = (visitId: number, action: 'CREATE' | 'EDIT') =>
        prisma.auditLog.findFirstOrThrow({ where: { tableName: 'Visit', affectedEntityId: visitId, action } });

    const inserts = [
        ['a member', asMember, (times: object) => memberInsert(request('/api/attendance/manual', 'POST', times), noParams)],
        ['the board', asBoard, (times: object) => staffInsert(request('/api/facility/visits/insert', 'POST', { personId: memberId, ...times }), noParams)],
    ] as const;
    const edits = [
        ['a member', asMember, (visitId: number, times: object) => memberEdit(request('/api/attendance/manual/x', 'PATCH', times), { params: Promise.resolve({ id: String(visitId) }) })],
        ['the board', asBoard, (visitId: number, times: object) => staffEdit(request('/api/facility/visits', 'PATCH', { visitId, ...times }), noParams)],
    ] as const;

    describe.each(inserts)('an insert by %s', (_who, signIn, insert) => {
        beforeEach(signIn);

        it('is refused when it overlaps an open visit', async () => {
            await openVisit();
            const res = await insert({ arrivedAt: ago(20).toISOString(), departedAt: ago(10).toISOString() });
            expect(res.status).toBe(409);
            expect((await res.json()).error).toMatch(/checked in from/i);
            expect(await prisma.visit.count({ where: { personId: memberId } })).toBe(1);
        });

        it('applies before an open visit began', async () => {
            await openVisit();
            const res = await insert({ arrivedAt: ago(60).toISOString(), departedAt: ago(40).toISOString() });
            expect(res.status).toBeLessThan(300);
            expect(await prisma.visit.count({ where: { personId: memberId } })).toBe(2);
        });

        it('applies and flags an overlap with a closed visit, naming it', async () => {
            const other = await closedVisit(60, 30);
            const res = await insert({ arrivedAt: ago(40).toISOString(), departedAt: ago(10).toISOString() });
            expect(res.status).toBeLessThan(300);
            const created = await prisma.visit.findFirstOrThrow({ where: { personId: memberId, id: { not: other.id } } });
            expect((await auditOf(created.id, 'CREATE')).newData).toMatchObject({ significance: { flagged: true }, overlapsVisitIds: [other.id] });
        });

        it('does not flag visits that only touch', async () => {
            const other = await closedVisit(60, 30);
            const res = await insert({ arrivedAt: other.departedAt!.toISOString(), departedAt: ago(10).toISOString() });
            expect(res.status).toBeLessThan(300);
            const created = await prisma.visit.findFirstOrThrow({ where: { personId: memberId, id: { not: other.id } } });
            expect((await auditOf(created.id, 'CREATE')).newData).not.toHaveProperty('overlapsVisitIds');
        });
    });

    describe.each(edits)('an edit by %s', (_who, signIn, edit) => {
        beforeEach(signIn);

        it('is refused when it moves onto an open visit, changing nothing', async () => {
            await openVisit();
            const visit = await closedVisit(120, 60);
            const res = await edit(visit.id, { departedAt: ago(10).toISOString() });
            expect(res.status).toBe(409);
            const after = await prisma.visit.findUniqueOrThrow({ where: { id: visit.id } });
            expect(after.departedAt!.getTime()).toBe(visit.departedAt!.getTime());
        });

        it('applies and flags when it moves onto a closed visit', async () => {
            const other = await closedVisit(50, 40);
            const visit = await closedVisit(120, 60);
            const res = await edit(visit.id, { departedAt: ago(45).toISOString() });
            expect(res.status).toBe(200);
            expect((await auditOf(visit.id, 'EDIT')).newData).toMatchObject({ significance: { flagged: true }, overlapsVisitIds: [other.id] });
        });

        it('does not count the visit against itself', async () => {
            const visit = await closedVisit(120, 60);
            const res = await edit(visit.id, { departedAt: ago(50).toISOString() });
            expect(res.status).toBe(200);
            expect((await auditOf(visit.id, 'EDIT')).newData).not.toHaveProperty('overlapsVisitIds');
        });
    });

    describe('closed out by a close', () => {
        it('lists only visits a close still ends, carrying which close', async () => {
            asBoard();
            const close = await prisma.facilityClose.create({ data: { closedAt: ago(5), closedById: boardId, via: 'KIOSK' } });
            const closedOut = await prisma.visit.create({
                data: { personId: memberId, arrivedAt: ago(60), departedAt: ago(5), departedVia: 'FACILITY_CLOSE', facilityCloseId: close.id },
            });
            await closedVisit(200, 150);
            // Its owner corrected the placeholder, so the close no longer ends it.
            await prisma.visit.create({
                data: { personId: memberId, arrivedAt: ago(300), departedAt: ago(250), departedVia: 'TYPED', facilityCloseId: close.id },
            });

            const res = await GET(request('/api/facility/visits?closedOut=true', 'GET'), noParams);
            expect(res.status).toBe(200);
            const { visits } = await res.json() as { visits: { id: number; personId: number; facilityCloseId: number }[] };
            const mine = visits.filter(v => v.personId === memberId);
            expect(mine.map(v => v.id)).toEqual([closedOut.id]);
            expect(mine[0].facilityCloseId).toBe(close.id);
        });
    });
});
