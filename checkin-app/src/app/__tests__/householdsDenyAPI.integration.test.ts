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
import { setRoleFlag } from '@/lib/roles';
import { seedSignedKeyVolunteer } from '@/lib/dev/seed-helpers';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@/generated/prisma/client';

jest.mock('next-auth/next', () => ({
    getServerSession: jest.fn(),
}));

// The test's own held transaction runs on this connection, so the app's single connection waits on the lock, not on the pool.
const holder = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });
afterAll(() => holder.$disconnect());

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
        await prisma.orgMembershipProcess.deleteMany({ where: { kind: 'KEY_VOLUNTEER_AGREEMENT', subjectPersonId: { in: ids.map(u => u.id) } } });
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

    it('waits for a board grant committing at the same moment, then refuses (409)', async () => {
        (getServerSession as jest.Mock).mockResolvedValue({ user: { id: boardId, isBoardMember: true } });
        // The lock is on existing BOARD rows; production always has at least one.
        await prisma.personRole.upsert({ where: { personId_role: { personId: boardId, role: 'BOARD' } }, create: { personId: boardId, role: 'BOARD' }, update: {} });
        const grantee = await prisma.person.create({
            data: { email: `grantee-${TAG}@example.com`, name: 'Grantee', household: { create: { name: "Test HH" } } },
        });

        await seedSignedKeyVolunteer(prisma, grantee.id);

        let deny: ReturnType<typeof post> | undefined;
        await holder.$transaction(async (tx) => {
            await setRoleFlag(tx, grantee.id, 'isBoardMember', true, { id: boardId, isBoardMember: true, isSysadmin: false });
            deny = post({ householdId: grantee.householdId, deny: true });
            // Commit only once the deny is queued behind this transaction's lock.
            let waiting = 0;
            for (let i = 0; i < 250 && waiting === 0; i++) {
                await new Promise((resolve) => setTimeout(resolve, 20));
                [{ waiting }] = await tx.$queryRaw<{ waiting: number }[]>`SELECT count(*)::int AS waiting FROM pg_locks WHERE NOT granted`;
            }
            expect(waiting).toBeGreaterThan(0);
        }, { timeout: 10_000 });

        const res = await deny!;
        expect(res.status).toBe(409);
        expect((await res.json()).error).toContain('board member');
        const membership = await prisma.orgMembership.findUnique({ where: { householdId: grantee.householdId } });
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

    it.each([
        ['INTAKE', {}],
        ['PENDING_EXTERNAL_ACTION', {}],
        ['PENDING_PAYMENT', { contractSignedAt: new Date(), bgClearedAt: new Date() }],
        ['BLOCKED', {}],
    ] as const)('deny closes an unpaid %s application in the same act, and leaves a paid one open for its refund', async (status, extra) => {
        (getServerSession as jest.Mock).mockResolvedValue({ user: { id: boardId, isBoardMember: true } });
        const lead = await prisma.person.create({
            data: { email: `deny-close-${status}-${TAG}@example.com`, name: 'Deny Lead', household: { create: { name: "Test HH" } } },
        });
        const membership = await prisma.orgMembership.create({ data: { householdId: lead.householdId, status: 'NONE' } });
        const unpaid = await prisma.orgMembershipProcess.create({ data: { orgMembershipId: membership.id, kind: 'INITIAL', status, ...extra } });
        const paid = await prisma.orgMembershipProcess.create({
            data: { orgMembershipId: membership.id, kind: 'RENEWAL', status: 'PENDING_BG_CLEARANCE', contractSignedAt: new Date(), paidAt: new Date() },
        });
        try {
            const res = await post({ householdId: lead.householdId, deny: true });
            expect(res.status).toBe(200);
            expect((await prisma.orgMembership.findUnique({ where: { id: membership.id } }))?.status).toBe('DENIED');
            const closed = await prisma.orgMembershipProcess.findUnique({ where: { id: unpaid.id } });
            expect([closed?.status, closed?.archivedFromStatus]).toEqual(['ARCHIVED', status]);
            const audit = await prisma.auditLog.findFirst({ where: { actorId: boardId, tableName: 'OrgMembershipProcess', affectedEntityId: unpaid.id } });
            expect(audit?.newData).toMatchObject({ status: 'ARCHIVED', reason: 'household denied' });
            expect((await prisma.orgMembershipProcess.findUnique({ where: { id: paid.id } }))?.status).toBe('PENDING_BG_CLEARANCE');
        } finally {
            await prisma.orgMembershipProcess.deleteMany({ where: { orgMembershipId: membership.id } });
        }
    });

    it('deny closes an unpaid clearance wait', async () => {
        (getServerSession as jest.Mock).mockResolvedValue({ user: { id: boardId, isBoardMember: true } });
        const lead = await prisma.person.create({
            data: { email: `deny-clearance-${TAG}@example.com`, name: 'Clearance Lead', household: { create: { name: "Test HH" } } },
        });
        const membership = await prisma.orgMembership.create({ data: { householdId: lead.householdId, status: 'NONE' } });
        const waiting = await prisma.orgMembershipProcess.create({
            data: { orgMembershipId: membership.id, kind: 'RENEWAL', status: 'PENDING_BG_CLEARANCE', contractSignedAt: new Date() },
        });
        try {
            expect((await post({ householdId: lead.householdId, deny: true })).status).toBe(200);
            expect((await prisma.orgMembership.findUnique({ where: { id: membership.id } }))?.status).toBe('DENIED');
            const closed = await prisma.orgMembershipProcess.findUnique({ where: { id: waiting.id } });
            expect([closed?.status, closed?.archivedFromStatus]).toEqual(['ARCHIVED', 'PENDING_BG_CLEARANCE']);
        } finally {
            await prisma.orgMembershipProcess.deleteMany({ where: { orgMembershipId: membership.id } });
        }
    });

    it('deny closes an unpaid legacy RENEWAL_PENDING_BG application', async () => {
        (getServerSession as jest.Mock).mockResolvedValue({ user: { id: boardId, isBoardMember: true } });
        const lead = await prisma.person.create({
            data: { email: `deny-legacy-${TAG}@example.com`, name: 'Legacy Lead', household: { create: { name: "Test HH" } } },
        });
        const membership = await prisma.orgMembership.create({ data: { householdId: lead.householdId, status: 'NONE' } });
        const legacy = await prisma.orgMembershipProcess.create({
            data: { orgMembershipId: membership.id, kind: 'RENEWAL', status: 'RENEWAL_PENDING_BG' },
        });
        try {
            expect((await post({ householdId: lead.householdId, deny: true })).status).toBe(200);
            const closed = await prisma.orgMembershipProcess.findUnique({ where: { id: legacy.id } });
            expect([closed?.status, closed?.archivedFromStatus]).toEqual(['ARCHIVED', 'RENEWAL_PENDING_BG']);
        } finally {
            await prisma.orgMembershipProcess.deleteMany({ where: { orgMembershipId: membership.id } });
        }
    });

    it('restore closes nothing, returns the household to NONE, and is refused while a refund is owed', async () => {
        (getServerSession as jest.Mock).mockResolvedValue({ user: { id: boardId, isBoardMember: true } });
        const lead = await prisma.person.create({
            data: { email: `restore-${TAG}@example.com`, name: 'Restore Lead', household: { create: { name: "Test HH" } } },
        });
        const membership = await prisma.orgMembership.create({ data: { householdId: lead.householdId, status: 'DENIED' } });
        const paid = await prisma.orgMembershipProcess.create({
            data: { orgMembershipId: membership.id, kind: 'INITIAL', status: 'PENDING_BG_CLEARANCE', contractSignedAt: new Date(), paidAt: new Date() },
        });
        try {
            const refused = await post({ householdId: lead.householdId, deny: false });
            expect(refused.status).toBe(409);
            expect((await refused.json()).error).toContain('record the refund');
            expect((await prisma.orgMembership.findUnique({ where: { id: membership.id } }))?.status).toBe('DENIED');

            await prisma.orgMembershipProcess.update({ where: { id: paid.id }, data: { status: 'ARCHIVED', archivedFromStatus: 'PENDING_PAYMENT', paidAt: null } });
            const auditsBefore = await prisma.auditLog.count({ where: { tableName: 'OrgMembershipProcess', affectedEntityId: paid.id } });
            const res = await post({ householdId: lead.householdId, deny: false });
            expect(res.status).toBe(200);
            expect((await prisma.orgMembership.findUnique({ where: { id: membership.id } }))?.status).toBe('NONE');
            expect(await prisma.auditLog.count({ where: { tableName: 'OrgMembershipProcess', affectedEntityId: paid.id } })).toBe(auditsBefore);
        } finally {
            await prisma.orgMembershipProcess.deleteMany({ where: { orgMembershipId: membership.id } });
        }
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
