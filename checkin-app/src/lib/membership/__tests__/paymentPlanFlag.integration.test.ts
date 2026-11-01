/**
 * @jest-environment node
 */
/**
 * A payment-plan request belongs to one stay at PENDING_PAYMENT. Whatever moves the
 * application on ends the request, so a later return to PENDING_PAYMENT never puts
 * it back on the Board's queue or the family's page.
 */
import { GET as queueGet } from '@/app/api/finance-ops/membership-payment-plans/route';
import prisma from '@/lib/prisma';
import { activateByProcessId } from '@/lib/membership/payment';
import { grantMembership } from '@/lib/membership/grant';
import { recordRefund } from '@/lib/membership/refund';
import { attest, boardResetReview } from '@/lib/membership/review';
import { archiveApplication, closeForRestore, lockOpenApplications, unarchiveApplication } from '@/lib/membership/archive';
import { personActor } from '@/lib/auditActor';

jest.mock('next-auth/next', () => ({ getServerSession: jest.fn() }));
jest.mock('@/lib/email');
jest.mock('@/lib/finance/reconcile/liveOrder', () => ({
    recordUnreportedReversal: jest.fn().mockResolvedValue(undefined),
    recordUnreportedReversalOnProcess: jest.fn().mockResolvedValue(undefined),
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const mockSession = require('next-auth/next').getServerSession;

const TAG = 'payment-plan-flag-test';

describe('payment-plan request ends when the application moves on', () => {
    let boardId: number;
    let seq = 0;

    async function requestedProcess(fields: { bgConsentAt?: Date; bgClearedAt?: Date } = { bgConsentAt: new Date() }) {
        const household = await prisma.household.create({ data: { name: `Family ${seq++} ${TAG}` } });
        const adult = await prisma.person.create({ data: { name: 'Adult', email: `adult-${seq}-${TAG}@example.com`, householdId: household.id } });
        await prisma.person.update({ where: { id: adult.id }, data: { isHouseholdLead: true } });
        const membership = await prisma.orgMembership.create({ data: { householdId: household.id, status: 'NONE', isVolunteerFamily: false } });
        const process = await prisma.orgMembershipProcess.create({
            data: { orgMembershipId: membership.id, kind: 'INITIAL', status: 'PENDING_PAYMENT', isPaymentPlanRequested: true, ...fields },
        });
        return { processId: process.id, householdId: household.id, orgMembershipId: membership.id, adultId: adult.id };
    }

    async function queueIds() {
        mockSession.mockResolvedValue({ user: { id: boardId, isBoardMember: true } });
        const res = await queueGet(new Request('http://localhost/api/finance-ops/membership-payment-plans') as unknown as import('next/server').NextRequest);
        expect(res.status).toBe(200);
        return (await res.json()).map((r: { id: number }) => r.id);
    }

    async function expectNoOpenRequest(processId: number) {
        const row = await prisma.orgMembershipProcess.findUniqueOrThrow({ where: { id: processId } });
        expect(row.status).toBe('PENDING_PAYMENT');
        expect(row.isPaymentPlanRequested).toBe(false);
        expect(await queueIds()).not.toContain(processId);
    }

    async function wipe() {
        const households = await prisma.household.findMany({ where: { name: { contains: TAG } }, select: { id: true } });
        const ids = households.map((h) => h.id);
        const processes = await prisma.orgMembershipProcess.findMany({ where: { orgMembership: { householdId: { in: ids } } }, select: { id: true } });
        const processIds = processes.map((p) => p.id);
        await prisma.backgroundCheckAttestation.deleteMany({ where: { processId: { in: processIds } } });
        await prisma.auditLog.deleteMany({ where: { tableName: 'OrgMembershipProcess', affectedEntityId: { in: processIds } } });
        await prisma.orgMembershipProcess.deleteMany({ where: { id: { in: processIds } } });
        await prisma.orgMembership.deleteMany({ where: { householdId: { in: ids } } });
        const people = await prisma.person.findMany({ where: { householdId: { in: ids } }, select: { id: true } });
        await prisma.auditLog.deleteMany({ where: { actorId: { in: people.map((p) => p.id) } } });
        await prisma.person.deleteMany({ where: { householdId: { in: ids } } });
        await prisma.household.deleteMany({ where: { id: { in: ids } } });
    }

    beforeAll(async () => {
        await wipe();
        const board = await prisma.person.create({
            data: { name: 'Flag Board', email: `board-${TAG}@example.com`, isBoardMember: true, household: { create: { name: `Board ${TAG}` } } },
        });
        boardId = board.id;
    });

    afterAll(async () => {
        await wipe();
        await prisma.$disconnect();
    });

    it('pay in Shopify, then refund: no request returns', async () => {
        const { processId } = await requestedProcess();
        const { outcome } = await activateByProcessId(processId, `order-${TAG}-${processId}`, { appliesToYear: null });
        expect(outcome).toBe('held');
        await recordRefund(processId, boardId, 'refunded in Shopify');
        await expectNoOpenRequest(processId);
    });

    it('Board grant, then refund: no request returns', async () => {
        const { processId, householdId } = await requestedProcess();
        await grantMembership(householdId, { actorId: boardId, reason: 'grant' }, 2026);
        await recordRefund(processId, boardId, 'grant undone');
        await expectNoOpenRequest(processId);
    });

    it('rejection, then Board reset: no request returns', async () => {
        const { processId } = await requestedProcess();
        await attest(boardId, processId, { result: 'REJECT' });
        await boardResetReview(processId, boardId);
        await expectNoOpenRequest(processId);
    });

    it('rejection, then the rejector changes to approve: no request returns', async () => {
        const { processId, adultId } = await requestedProcess();
        await attest(boardId, processId, { result: 'REJECT' });
        await attest(boardId, processId, { result: 'APPROVE', subjectPersonIds: [adultId] });
        await expectNoOpenRequest(processId);
    });

    it('close, then reopen: no request returns', async () => {
        const { processId } = await requestedProcess();
        await archiveApplication(processId, boardId);
        await unarchiveApplication(processId, boardId);
        await expectNoOpenRequest(processId);
    });

    it('a restore closing the application ends the request', async () => {
        const { processId, orgMembershipId } = await requestedProcess();
        await prisma.$transaction(async (tx) => closeForRestore(tx, await lockOpenApplications(tx, orgMembershipId), personActor(boardId)));
        await unarchiveApplication(processId, boardId);
        await expectNoOpenRequest(processId);
    });

    it('a row already paid with the flag still set loses it when refunded', async () => {
        const { processId } = await requestedProcess();
        await prisma.orgMembershipProcess.update({ where: { id: processId }, data: { status: 'PENDING_BG_CLEARANCE', paidAt: new Date() } });
        await recordRefund(processId, boardId, 'refunded in Shopify');
        await expectNoOpenRequest(processId);
    });

    it('a real open request stays listed through what leaves it at PENDING_PAYMENT', async () => {
        const { processId, adultId } = await requestedProcess();
        await activateByProcessId(processId, `order-noitem-${TAG}-${processId}`, null);
        await attest(boardId, processId, { result: 'APPROVE', subjectPersonIds: [adultId] });
        await boardResetReview(processId, boardId);

        const row = await prisma.orgMembershipProcess.findUniqueOrThrow({ where: { id: processId } });
        expect(row.status).toBe('PENDING_PAYMENT');
        expect(row.isPaymentPlanRequested).toBe(true);
        expect(await queueIds()).toContain(processId);
    });
});
