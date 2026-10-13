/**
 * @jest-environment node
 */
/**
 * Integration tests for the board "Deny Membership" action on
 * POST /api/membership-ops/households — deny/restore, the board-member guard,
 * audit logging, and the API-level login lockout.
 */

import { POST } from '@/app/api/membership-ops/households/route';
import { authenticateRequest } from '@/lib/auth';
import prisma from '@/lib/prisma';
import { getServerSession } from 'next-auth/next';

jest.mock('next-auth/next', () => ({
    getServerSession: jest.fn(),
}));

const TAG = 'deny-api-test';

function post(body: unknown) {
    return POST(new Request('http://localhost:4000/api/membership-ops/households', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    }) as unknown as import('next/server').NextRequest);
}

describe('POST /api/membership-ops/households — Deny Membership', () => {
    let boardId: number;
    let plainHouseholdId: number;
    let plainMemberId: number;
    let boardHouseholdId: number;

    beforeAll(async () => {
        const leaked = await prisma.person.findMany({
            where: { email: { contains: TAG } }, select: { id: true },
        });
        await prisma.auditLog.deleteMany({ where: { actorId: { in: leaked.map(u => u.id) } } });
        await prisma.person.deleteMany({ where: { email: { contains: TAG } } });

        // Acting board member (in their own household).
        const board = await prisma.person.create({
            data: { email: `board-${TAG}@example.com`, name: 'Board Actor', isBoardMember: true, household: { create: { name: "Test HH" } } },
        });
        boardId = board.id;

        // A plain household to deny.
        const member = await prisma.person.create({
            data: { email: `member-${TAG}@example.com`, name: 'Plain Member', household: { create: { name: "Test HH" } } },
        });
        plainMemberId = member.id;
        plainHouseholdId = member.householdId;

        // A household that contains a board member — must be undeniable.
        const protectedBoard = await prisma.person.create({
            data: { email: `protected-${TAG}@example.com`, name: 'Protected Board', isBoardMember: true, household: { create: { name: "Test HH" } } },
        });
        boardHouseholdId = protectedBoard.householdId;
    });

    afterAll(async () => {
        const ids = await prisma.person.findMany({
            where: { email: { contains: TAG } }, select: { id: true, householdId: true },
        });
        await prisma.auditLog.deleteMany({ where: { actorId: { in: ids.map(u => u.id) } } });
        await prisma.orgMembership.deleteMany({ where: { householdId: { in: ids.map(u => u.householdId) } } });
        await prisma.person.deleteMany({ where: { email: { contains: TAG } } });
        await prisma.household.deleteMany({ where: { id: { in: ids.map(u => u.householdId) } } });
    });

    it('rejects an unauthenticated caller (401)', async () => {
        (getServerSession as jest.Mock).mockResolvedValue(null);

        const res = await post({ householdId: plainHouseholdId, deny: true });
        expect(res.status).toBe(401);
    });

    it('rejects a non-board, non-sysadmin caller (403)', async () => {
        (getServerSession as jest.Mock).mockResolvedValue({ user: { id: plainMemberId } });

        const res = await post({ householdId: plainHouseholdId, deny: true });
        expect(res.status).toBe(403);

        const membership = await prisma.orgMembership.findUnique({ where: { householdId: plainHouseholdId } });
        expect(membership?.status).not.toBe('DENIED');
    });

    it('rejects denying a household that contains a board member (409)', async () => {
        (getServerSession as jest.Mock).mockResolvedValue({ user: { id: boardId, isBoardMember: true } });

        const res = await post({ householdId: boardHouseholdId, deny: true });
        expect(res.status).toBe(409);
        const data = await res.json();
        expect(data.error).toContain('board member');

        const membership = await prisma.orgMembership.findUnique({ where: { householdId: boardHouseholdId } });
        expect(membership?.status).not.toBe('DENIED');
    });

    it('denies a plain household, sets DENIED, and writes an audit row', async () => {
        (getServerSession as jest.Mock).mockResolvedValue({ user: { id: boardId, isBoardMember: true } });

        const res = await post({ householdId: plainHouseholdId, deny: true });
        expect(res.status).toBe(200);

        const membership = await prisma.orgMembership.findUnique({ where: { householdId: plainHouseholdId } });
        expect(membership?.status).toBe('DENIED');

        const audit = await prisma.auditLog.findFirst({
            where: { actorId: boardId, tableName: 'OrgMembership', affectedEntityId: membership!.id },
            orderBy: { id: 'desc' },
        });
        expect(audit).not.toBeNull();
        expect((audit!.newData as { status: string }).status).toBe('DENIED');
    });

    it('locks the denied household out at the API layer (denied session reads as unauthenticated)', async () => {
        (getServerSession as jest.Mock).mockResolvedValue({ user: { id: plainMemberId, denied: true } });

        const auth = await authenticateRequest(
            new Request('http://localhost:4000/api/anything') as unknown as import('next/server').NextRequest,
        );
        expect(auth.type).toBe('unauthenticated');
    });

    it('restores a denied household back to NONE', async () => {
        (getServerSession as jest.Mock).mockResolvedValue({ user: { id: boardId, isBoardMember: true } });

        const res = await post({ householdId: plainHouseholdId, deny: false });
        expect(res.status).toBe(200);

        const membership = await prisma.orgMembership.findUnique({ where: { householdId: plainHouseholdId } });
        expect(membership?.status).toBe('NONE');
    });

    it('restore is undeny only: it never moves an ACTIVE household to NONE', async () => {
        (getServerSession as jest.Mock).mockResolvedValue({ user: { id: boardId, isBoardMember: true } });
        await prisma.orgMembership.update({ where: { householdId: plainHouseholdId }, data: { status: 'ACTIVE' } });

        const res = await post({ householdId: plainHouseholdId, deny: false });
        expect(res.status).toBe(409);
        const membership = await prisma.orgMembership.findUnique({ where: { householdId: plainHouseholdId } });
        expect(membership?.status).toBe('ACTIVE');
    });

    it('denies an ACTIVE household', async () => {
        (getServerSession as jest.Mock).mockResolvedValue({ user: { id: boardId, isBoardMember: true } });
        const res = await post({ householdId: plainHouseholdId, deny: true });
        expect(res.status).toBe(200);
        const membership = await prisma.orgMembership.findUnique({ where: { householdId: plainHouseholdId } });
        expect(membership?.status).toBe('DENIED');
    });
});
