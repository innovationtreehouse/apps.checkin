/**
 * @jest-environment node
 *
 * POST /api/membership-ops/applications/settle-waiting against real Postgres: a waiting
 * application whose lead already holds a valid check is moved on by one Board call, and the
 * call leaves one audit row naming who ran it with the counts.
 */
import { getServerSession } from 'next-auth/next';
import prisma from '@/lib/prisma';
import { setBgRecheckPolicy } from '@/test-helpers/boardSettings';
import { POST } from '../route';

jest.mock('next-auth/next', () => ({ getServerSession: jest.fn() }));
jest.mock('@/lib/email', () => ({ runPaced: (tasks: Array<() => Promise<unknown>>) => Promise.all(tasks.map((t) => t())), sendEmail: jest.fn().mockResolvedValue(true) }));
jest.mock('@/lib/emailRecipients', () => ({ ...jest.requireActual('@/lib/emailRecipients'), emailBoardMembers: jest.fn().mockResolvedValue(1) }));
jest.mock('@/lib/finance/reconcile/liveOrder', () => ({
    recordUnreportedReversal: jest.fn().mockResolvedValue(undefined),
    recordUnreportedReversalOnProcess: jest.fn().mockResolvedValue(undefined),
}));

const TAG = 'settle-waiting-route-test';
let restorePolicy: () => Promise<void> = async () => {};
let boardId: number;

async function wipe() {
    const households = await prisma.household.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } });
    const ids = households.map((h) => h.id);
    const processes = await prisma.orgMembershipProcess.findMany({ where: { OR: [{ orgMembership: { householdId: { in: ids } } }, { requestedForHouseholdId: { in: ids } }] }, select: { id: true } });
    const processIds = processes.map((p) => p.id);
    const people = await prisma.person.findMany({ where: { email: { contains: TAG } }, select: { id: true } });
    await prisma.auditLog.deleteMany({ where: { tableName: 'OrgMembershipProcess', affectedEntityId: { in: processIds } } });
    await prisma.auditLog.deleteMany({ where: { tableName: 'APPLICATION_SETTLE_SWEEP', actorId: { in: people.map((p) => p.id) } } });
    await prisma.orgMembershipProcess.deleteMany({ where: { id: { in: processIds } } });
    await prisma.orgMembership.deleteMany({ where: { householdId: { in: ids } } });
    await prisma.person.deleteMany({ where: { email: { contains: TAG } } });
    await prisma.household.deleteMany({ where: { id: { in: ids } } });
}

beforeAll(async () => {
    restorePolicy = await setBgRecheckPolicy();
    await wipe();
    const boardHousehold = await prisma.household.create({ data: { name: `${TAG} board` } });
    boardId = (await prisma.person.create({ data: { name: 'Board', email: `board-${TAG}@example.com`, householdId: boardHousehold.id, isBoardMember: true } })).id;
});

afterAll(async () => {
    await wipe();
    await restorePolicy();
    await prisma.$disconnect();
});

it('moves on a waiting application whose lead holds a valid check, and audits the call', async () => {
    const household = await prisma.household.create({ data: { name: `${TAG} family` } });
    await prisma.person.create({ data: { name: 'Lead', email: `lead-${TAG}@example.com`, householdId: household.id, isHouseholdLead: true, lastBackgroundCheck: new Date() } });
    const membership = await prisma.orgMembership.create({ data: { householdId: household.id, status: 'NONE' } });
    const app = await prisma.orgMembershipProcess.create({ data: { orgMembershipId: membership.id, kind: 'INITIAL', status: 'PENDING_EXTERNAL_ACTION' } });
    jest.mocked(getServerSession).mockResolvedValue({ user: { id: boardId, isBoardMember: true }, expires: '2099-01-01' });

    const res = await POST(new Request('http://localhost/api/membership-ops/applications/settle-waiting', { method: 'POST' }) as never);

    expect(res.status).toBe(200);
    const counts = await res.json();
    expect(Object.keys(counts).sort()).toEqual(['failed', 'households', 'opened']);
    expect(counts.households).toBeGreaterThanOrEqual(1);
    expect(counts.failed).toBe(0);
    expect((await prisma.orgMembershipProcess.findUniqueOrThrow({ where: { id: app.id } })).bgClearedAt).not.toBeNull();
    const audits = await prisma.auditLog.findMany({ where: { tableName: 'APPLICATION_SETTLE_SWEEP', actorId: boardId } });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ action: 'EDIT', actorSystem: null, newData: counts });
});
