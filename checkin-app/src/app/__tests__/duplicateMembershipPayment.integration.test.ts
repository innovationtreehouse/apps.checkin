/**
 * @jest-environment node
 */
/**
 * A second payment for a membership year that is already settled is raised as a
 * DUPLICATE_MEMBERSHIP_PAYMENT whose wording names how the year was settled. A
 * payment on an application that was never paid stays UNMATCHED_ORDER.
 */

import { activateByProcessId, certifyPaymentPlan } from '@/lib/membership/payment';
import { grantMembership } from '@/lib/membership/grant';
import { DUPLICATE_MEMBERSHIP_WORDING, raiseMembershipPaymentOutcome } from '@/lib/finance/reconcile/membership';
import prisma from '@/lib/prisma';

jest.mock('@/lib/email', () => ({
    sendEmail: jest.fn().mockResolvedValue(true),
    runPaced: (tasks: Array<() => Promise<unknown>>) => Promise.all(tasks.map((t) => t())),
}));

const TAG = 'dup-membership-pay-test';
const orderId = (label: string) => `${TAG}-${label}-${Math.random().toString(36).slice(2)}`;
const LINE = { appliesToYear: 2026 };

let boardId: number;

/** A household with one lead and an INITIAL application at the given step; the check is not cleared, so a payment holds it. */
async function makeApplicant(status: 'PENDING_PAYMENT' | 'PENDING_BG_REVIEW') {
    const hh = await prisma.household.create({ data: { name: `Applicant ${TAG} ${Math.random()}` } });
    const lead = await prisma.person.create({ data: { email: `lead-${Math.random()}-${TAG}@example.com`, name: 'Lead', householdId: hh.id, isHouseholdLead: true } });
    const m = await prisma.orgMembership.create({ data: { householdId: hh.id, status: 'NONE' } });
    const now = new Date();
    const proc = await prisma.orgMembershipProcess.create({
        data: { orgMembershipId: m.id, kind: 'INITIAL', status, contractSignedAt: now, bgConsentAt: now },
    });
    return { processId: proc.id, householdId: hh.id, leadId: lead.id };
}

/** Pay the application in the store with a second order and raise what the outcome needs. */
async function payAgain(processId: number) {
    const oid = orderId('second');
    const { outcome } = await activateByProcessId(processId, oid, LINE);
    await raiseMembershipPaymentOutcome(outcome, { shopifyOrderId: oid, processId });
    return { outcome, exceptions: await prisma.paymentException.findMany({ where: { shopifyOrderId: oid } }) };
}

async function wipe() {
    await prisma.paymentException.deleteMany({ where: { shopifyOrderId: { startsWith: `${TAG}-` } } });
    const hhs = await prisma.household.findMany({ where: { name: { contains: TAG } }, select: { id: true } });
    const ids = hhs.map((h) => h.id);
    if (ids.length) {
        const processes = { OR: [{ orgMembership: { householdId: { in: ids } } }, { requestedForHouseholdId: { in: ids } }] };
        const procIds = (await prisma.orgMembershipProcess.findMany({ where: processes, select: { id: true } })).map((p) => p.id);
        await prisma.paymentException.deleteMany({ where: { processId: { in: procIds } } });
        await prisma.auditLog.deleteMany({ where: { tableName: 'OrgMembershipProcess', affectedEntityId: { in: procIds } } });
        await prisma.orgMembershipProcess.deleteMany({ where: processes });
        await prisma.orgMembership.deleteMany({ where: { householdId: { in: ids } } });
        await prisma.person.deleteMany({ where: { householdId: { in: ids } } });
        await prisma.household.deleteMany({ where: { id: { in: ids } } });
    }
}

beforeAll(async () => {
    await wipe();
    const board = await prisma.person.create({
        data: { email: `board-${TAG}@example.com`, name: 'Board', isBoardMember: true, household: { create: { name: `Board HH ${TAG}` } } },
    });
    boardId = board.id;
});

afterAll(async () => {
    await wipe();
    await prisma.$disconnect();
});

describe('a second payment for a settled membership year', () => {
    it('paid twice in the store raises a duplicate membership payment', async () => {
        const { processId } = await makeApplicant('PENDING_PAYMENT');
        expect((await activateByProcessId(processId, orderId('first'), LINE)).outcome).toBe('held');

        const { outcome, exceptions } = await payAgain(processId);

        expect(outcome).toBe('nothing_due');
        expect(exceptions).toEqual([
            expect.objectContaining({ kind: 'DUPLICATE_MEMBERSHIP_PAYMENT', processId, evidence: DUPLICATE_MEMBERSHIP_WORDING.store }),
        ]);
    });

    it('paid after the Board certified a plan raises a duplicate membership payment', async () => {
        const { processId } = await makeApplicant('PENDING_PAYMENT');
        await certifyPaymentPlan(processId, boardId, { reason: 'plan agreed', year: 2026 });

        const { exceptions } = await payAgain(processId);

        expect(exceptions).toEqual([
            expect.objectContaining({ kind: 'DUPLICATE_MEMBERSHIP_PAYMENT', processId, evidence: DUPLICATE_MEMBERSHIP_WORDING.certified }),
        ]);
    });

    it('paid after the Board granted the year raises a duplicate membership payment', async () => {
        const { processId, householdId } = await makeApplicant('PENDING_PAYMENT');
        await grantMembership(householdId, { actorId: boardId, reason: 'hardship' }, 2026);

        const { exceptions } = await payAgain(processId);

        expect(exceptions).toEqual([
            expect.objectContaining({ kind: 'DUPLICATE_MEMBERSHIP_PAYMENT', processId, evidence: DUPLICATE_MEMBERSHIP_WORDING.granted }),
        ]);
    });

    it('a payment before payment was due stays an unmatched order', async () => {
        const { processId } = await makeApplicant('PENDING_BG_REVIEW');

        const { outcome, exceptions } = await payAgain(processId);

        expect(outcome).toBe('nothing_due');
        expect(exceptions).toEqual([expect.objectContaining({ kind: 'UNMATCHED_ORDER', processId })]);
    });
});
