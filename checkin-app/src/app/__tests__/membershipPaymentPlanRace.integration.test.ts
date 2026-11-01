/**
 * @jest-environment node
 */
/**
 * A payment-plan request is decided once: an approval and a denial racing each
 * other cannot both take effect. Runs on a pool of 2 (jest.setup.js), so the
 * in-flight deny and the approve sit on separate connections and the process row
 * lock is what orders them.
 */
import { POST as ApprovePost } from '@/app/api/finance-ops/membership-payment-plans/route';
import { POST as DenyPost } from '@/app/api/finance-ops/membership-payment-plans/refuse/route';
import prisma from '@/lib/prisma';

jest.mock('next-auth/next', () => ({ getServerSession: jest.fn() }));
jest.mock('@/lib/email');

type Gate = { reached: Promise<void>; arrive: () => void; release: () => void; released: Promise<void> };
function makeGate(): Gate {
    let arrive = () => {};
    let release = () => {};
    const reached = new Promise<void>((r) => { arrive = r; });
    const released = new Promise<void>((r) => { release = r; });
    return { reached, arrive, release, released };
}

// Each gate holds the next call to its step until the test releases it.
let mockBeforeLockGate: Gate | null = null;
let mockAfterCommitGate: Gate | null = null;
async function mockPassGate(gate: Gate | null) {
    if (!gate) return;
    gate.arrive();
    await gate.released;
}

// Certify's conflict check runs after the route's first read and before settle takes its locks.
jest.mock('@/lib/conflictOfInterest', () => {
    const actual = jest.requireActual<typeof import('@/lib/conflictOfInterest')>('@/lib/conflictOfInterest');
    return {
        ...actual,
        hasHouseholdConflict: async (...args: Parameters<typeof actual.hasHouseholdConflict>) => {
            const gate = mockBeforeLockGate;
            mockBeforeLockGate = null;
            await mockPassGate(gate);
            return actual.hasHouseholdConflict(...args);
        },
    };
});

// Runs after settle's transaction commits and before the approve call returns.
jest.mock('@/lib/membership/personBgTriggers', () => ({
    openPersonBgForNewMember: async () => {
        const gate = mockAfterCommitGate;
        mockAfterCommitGate = null;
        await mockPassGate(gate);
    },
}));

const mockSession = jest.requireMock<{ getServerSession: jest.Mock }>('next-auth/next').getServerSession;

const TAG = 'membership-plan-race-test';

function approveReq(processId: number) {
    return new Request('http://localhost/api/finance-ops/membership-payment-plans', {
        method: 'POST',
        body: JSON.stringify({ processId, reason: 'Board approved plan' }),
    }) as unknown as import('next/server').NextRequest;
}
function denyReq(processId: number) {
    return new Request('http://localhost/api/finance-ops/membership-payment-plans/refuse', {
        method: 'POST',
        body: JSON.stringify({ processId }),
    }) as unknown as import('next/server').NextRequest;
}

async function waitForBlockedBackend(tx: Pick<typeof prisma, '$queryRaw'>) {
    for (let i = 0; i < 100; i++) {
        // Postgres caches pg_stat_activity for the transaction unless the snapshot is cleared.
        await tx.$queryRaw`SELECT pg_stat_clear_snapshot()::text`;
        const [{ blocked }] = await tx.$queryRaw<{ blocked: number }[]>`
            SELECT count(*)::int AS blocked FROM pg_stat_activity
            WHERE datname = current_database() AND wait_event_type = 'Lock'`;
        if (blocked > 0) return;
        await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('The approve never blocked on the row lock.');
}

describe('payment-plan approve and deny race', () => {
    let boardX: number;
    let boardY: number;
    let seq = 0;

    async function makeRequest(bgCleared: boolean) {
        const household = await prisma.household.create({ data: { name: `Race-${seq++} ${TAG}` } });
        const membership = await prisma.orgMembership.create({ data: { householdId: household.id, status: 'NONE' } });
        const process = await prisma.orgMembershipProcess.create({
            data: {
                orgMembershipId: membership.id,
                kind: 'INITIAL',
                status: 'PENDING_PAYMENT',
                bgClearedAt: bgCleared ? new Date() : null,
                isPaymentPlanRequested: true,
            },
        });
        return { processId: process.id, membershipId: membership.id };
    }

    const audits = (processId: number) =>
        prisma.auditLog.findMany({ where: { tableName: 'OrgMembershipProcess', affectedEntityId: processId } });

    async function expectOnlyDenied(processId: number, membershipId: number) {
        const process = await prisma.orgMembershipProcess.findUniqueOrThrow({ where: { id: processId } });
        expect(process.status).toBe('PENDING_PAYMENT');
        expect(process.paidAt).toBeNull();
        expect(process.isPaymentPlanRequested).toBe(false);
        const membership = await prisma.orgMembership.findUniqueOrThrow({ where: { id: membershipId } });
        expect(membership.status).toBe('NONE');
        const rows = await audits(processId);
        expect(rows).toHaveLength(1);
        expect(rows[0].newData).toMatchObject({ paymentPlanDenied: true });
    }

    async function wipe() {
        const households = await prisma.household.findMany({ where: { name: { contains: TAG } }, select: { id: true } });
        const ids = households.map((h) => h.id);
        await prisma.orgMembershipProcess.deleteMany({ where: { orgMembership: { householdId: { in: ids } } } });
        await prisma.orgMembership.deleteMany({ where: { householdId: { in: ids } } });
        await prisma.person.deleteMany({ where: { email: { contains: TAG } } });
        await prisma.household.deleteMany({ where: { name: { contains: TAG } } });
    }

    beforeAll(async () => {
        await wipe();
        const make = (label: string) =>
            prisma.person.create({
                data: { name: label, email: `${label}-${TAG}@example.com`, isBoardMember: true, household: { create: { name: `${label} ${TAG}` } } },
            });
        boardX = (await make('board-x')).id;
        boardY = (await make('board-y')).id;
    });

    afterEach(() => {
        mockBeforeLockGate = null;
        mockAfterCommitGate = null;
    });

    afterAll(wipe);

    it.each([
        ['cleared', true],
        ['not cleared', false],
    ])('a deny that commits before the approve takes its locks refuses the approve (background check %s)', async (_label, bgCleared) => {
        const { processId, membershipId } = await makeRequest(bgCleared);
        const gate = makeGate();
        mockBeforeLockGate = gate;

        mockSession.mockResolvedValueOnce({ user: { id: boardX, isBoardMember: true } });
        const approve = ApprovePost(approveReq(processId));
        await gate.reached;

        mockSession.mockResolvedValueOnce({ user: { id: boardY, isBoardMember: true } });
        expect((await DenyPost(denyReq(processId))).status).toBe(200);

        gate.release();
        expect((await approve).status).toBe(409);
        await expectOnlyDenied(processId, membershipId);
    });

    it('an approve waiting on the row lock of an uncommitted deny is refused once the deny commits', async () => {
        const { processId, membershipId } = await makeRequest(true);
        let approve!: ReturnType<typeof ApprovePost>;

        await prisma.$transaction(async (tx) => {
            await tx.orgMembershipProcess.updateMany({
                where: { id: processId, isPaymentPlanRequested: true, status: 'PENDING_PAYMENT' },
                data: { isPaymentPlanRequested: false },
            });
            await tx.auditLog.create({
                data: {
                    actorId: boardY,
                    action: 'EDIT',
                    tableName: 'OrgMembershipProcess',
                    affectedEntityId: processId,
                    newData: { paymentPlanDenied: true, isPaymentPlanRequested: false },
                },
            });
            mockSession.mockResolvedValueOnce({ user: { id: boardX, isBoardMember: true } });
            approve = ApprovePost(approveReq(processId));
            await waitForBlockedBackend(tx);
        }, { timeout: 15000 });

        expect((await approve).status).toBe(409);
        await expectOnlyDenied(processId, membershipId);
    });

    it('an approve commits the flag and its audit row with the activation, and a later deny is refused', async () => {
        const { processId, membershipId } = await makeRequest(true);
        const gate = makeGate();
        mockAfterCommitGate = gate;

        mockSession.mockResolvedValueOnce({ user: { id: boardX, isBoardMember: true } });
        const approve = ApprovePost(approveReq(processId));
        await gate.reached;

        try {
            mockSession.mockResolvedValueOnce({ user: { id: boardY, isBoardMember: true } });
            expect((await DenyPost(denyReq(processId))).status).toBe(409);

            const process = await prisma.orgMembershipProcess.findUniqueOrThrow({ where: { id: processId } });
            expect(process.status).toBe('ACTIVE');
            expect(process.isPaymentPlanRequested).toBe(false);
            const membership = await prisma.orgMembership.findUniqueOrThrow({ where: { id: membershipId } });
            expect(membership.status).toBe('ACTIVE');
            const rows = await audits(processId);
            expect(rows.some((r) => (r.newData as { paymentPlanApproved?: boolean }).paymentPlanApproved === true)).toBe(true);
            expect(rows.some((r) => (r.newData as { paymentPlanDenied?: boolean }).paymentPlanDenied === true)).toBe(false);
        } finally {
            gate.release();
        }
        expect((await approve).status).toBe(200);
    });
});
