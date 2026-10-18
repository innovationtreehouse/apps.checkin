/**
 * @jest-environment node
 */
/**
 * A refunded order never activates a membership; the app stops and raises it to
 * the Board. Covers both activation paths: a late orders/paid after the refund
 * (payment-first) and a second approval after the refund (check-last).
 */

import { attest, overrideBlocked } from '@/lib/membership/review';
import { activateByProcessId } from '@/lib/membership/payment';
import { raiseReversalByOrderId } from '@/lib/finance/reconcile/reversals';
import { raiseMembershipPaymentOutcome } from '@/lib/finance/reconcile/membership';
import prisma from '@/lib/prisma';
import { sendEmail } from '@/lib/email';

jest.mock('@/lib/email', () => ({
    sendEmail: jest.fn().mockResolvedValue(true),
    runPaced: (tasks: Array<() => Promise<unknown>>) => Promise.all(tasks.map((t) => t())),
}));

const TAG = 'refund-gate-test';
const orderId = (label: string) => `${TAG}-${label}-${Math.random().toString(36).slice(2)}`;

async function makePerson(label: string, extra: { isBackgroundCheckReviewer?: boolean; isBoardMember?: boolean }) {
    const p = await prisma.person.create({
        data: { email: `${label}-${TAG}@example.com`, name: label, ...extra, household: { create: { name: `${label} HH ${TAG}` } } },
    });
    return p.id;
}

/** A household with one lead, a NONE membership and an INITIAL process in the given state. */
async function makeApplicant(data: { status: 'PENDING_PAYMENT' | 'PENDING_BG_CLEARANCE' | 'BLOCKED'; paid?: boolean; bgCleared?: boolean; shopifyOrderId?: string }) {
    const hh = await prisma.household.create({ data: { name: `Applicant ${TAG} ${Math.random()}` } });
    const lead = await prisma.person.create({ data: { email: `lead-${Math.random()}-${TAG}@example.com`, name: 'Lead', householdId: hh.id } });
    await prisma.person.update({ where: { id: lead.id }, data: { isHouseholdLead: true } });
    const m = await prisma.orgMembership.create({ data: { householdId: hh.id, status: 'NONE' } });
    const now = new Date();
    const proc = await prisma.orgMembershipProcess.create({
        data: {
            orgMembershipId: m.id,
            kind: 'INITIAL',
            status: data.status,
            contractSignedAt: now,
            bgConsentAt: now,
            bgClearedAt: data.bgCleared ? now : null,
            paidAt: data.paid ? now : null,
            shopifyOrderId: data.shopifyOrderId ?? null,
        },
    });
    return { processId: proc.id, orgMembershipId: m.id, leadId: lead.id };
}

const processOf = (id: number) => prisma.orgMembershipProcess.findUnique({ where: { id } });
const membershipStatusOf = async (id: number) => (await prisma.orgMembership.findUnique({ where: { id } }))?.status;
const emailed = (text: string) =>
    (sendEmail as jest.Mock).mock.calls.some((args: unknown[]) => args.some((a) => typeof a === 'string' && a.includes(text)));

async function wipe() {
    await prisma.paymentException.deleteMany({ where: { shopifyOrderId: { startsWith: `${TAG}-` } } });
    await prisma.auditLog.deleteMany({ where: { tableName: 'ShopifyOrderReversal', newData: { path: ['shopifyOrderId'], string_starts_with: `${TAG}-` } } });
    const hhs = await prisma.household.findMany({ where: { name: { contains: TAG } }, select: { id: true } });
    const ids = hhs.map((h) => h.id);
    if (ids.length) {
        await prisma.backgroundCheckAttestation.deleteMany({ where: { process: { orgMembership: { householdId: { in: ids } } } } });
        await prisma.orgMembershipProcess.deleteMany({ where: { orgMembership: { householdId: { in: ids } } } });
        await prisma.orgMembership.deleteMany({ where: { householdId: { in: ids } } });
        await prisma.person.deleteMany({ where: { householdId: { in: ids } } });
        await prisma.household.deleteMany({ where: { id: { in: ids } } });
    }
}

describe('a refunded order never activates', () => {
    let revA: number, revB: number, board: number;

    beforeAll(async () => {
        await wipe();
        revA = await makePerson('RevA', { isBackgroundCheckReviewer: true });
        revB = await makePerson('RevB', { isBackgroundCheckReviewer: true });
        board = await makePerson('Board', { isBoardMember: true });
    });
    beforeEach(() => (sendEmail as jest.Mock).mockClear());
    afterAll(async () => {
        await wipe();
        await prisma.$disconnect();
    });

    it('path A: a refund before orders/paid is kept, and the late orders/paid is raised, not applied', async () => {
        const oid = orderId('A');
        const { processId, orgMembershipId } = await makeApplicant({ status: 'PENDING_PAYMENT', bgCleared: true });

        // The refund matches no application yet.
        expect(await raiseReversalByOrderId(oid, 'REFUND', [], `${oid}-r1`)).toBe(false);

        // A retried orders/paid carries the original paid payload.
        const { outcome } = await activateByProcessId(processId, oid, true);
        await raiseMembershipPaymentOutcome(outcome, { shopifyOrderId: oid, processId });

        expect(outcome).toBe('refunded');
        const proc = await processOf(processId);
        expect(proc?.status).toBe('PENDING_PAYMENT');
        expect(proc?.paidAt).toBeNull();
        expect(await membershipStatusOf(orgMembershipId)).toBe('NONE');
        const ex = await prisma.paymentException.findFirst({ where: { kind: 'REVERSED_BEFORE_ACTIVATION', processId } });
        expect(ex?.severity).toBe('CRITICAL');
        expect(emailed('Payment problem (REVERSED_BEFORE_ACTIVATION)')).toBe(true);
    });

    it('path B: a refund on a paid application waiting on its check is CRITICAL, and the second approval does not activate', async () => {
        const oid = orderId('B');
        const { processId, orgMembershipId, leadId } = await makeApplicant({ status: 'PENDING_BG_CLEARANCE', paid: true, shopifyOrderId: oid });

        expect(await raiseReversalByOrderId(oid, 'REFUND', [], `${oid}-r1`)).toBe(true);
        const refund = await prisma.paymentException.findFirst({ where: { kind: 'REFUND', processId } });
        expect(refund?.severity).toBe('CRITICAL');
        expect(emailed('Payment problem (REFUND)')).toBe(true);

        await attest(revA, processId, { result: 'APPROVE', subjectPersonIds: [leadId] });
        await attest(revB, processId, { result: 'APPROVE', subjectPersonIds: [leadId] });

        const proc = await processOf(processId);
        expect(proc?.status).toBe('PENDING_BG_CLEARANCE');
        expect(proc?.bgClearedAt).toBeTruthy();
        expect(await membershipStatusOf(orgMembershipId)).toBe('NONE');
        expect(await prisma.paymentException.count({ where: { kind: 'REVERSED_BEFORE_ACTIVATION', processId } })).toBe(1);
    });

    it('path B: the Board resolving the refund flag before clearance still does not activate', async () => {
        const oid = orderId('Bres');
        const { processId, orgMembershipId, leadId } = await makeApplicant({ status: 'PENDING_BG_CLEARANCE', paid: true, shopifyOrderId: oid });

        await raiseReversalByOrderId(oid, 'REFUND', [], `${oid}-r1`);
        await prisma.paymentException.updateMany({
            where: { kind: 'REFUND', processId },
            data: { status: 'RESOLVED', resolvedAt: new Date(), resolvedById: board, resolutionNote: 'noted' },
        });
        (sendEmail as jest.Mock).mockClear();

        await attest(revA, processId, { result: 'APPROVE', subjectPersonIds: [leadId] });
        await attest(revB, processId, { result: 'APPROVE', subjectPersonIds: [leadId] });

        expect((await processOf(processId))?.status).toBe('PENDING_BG_CLEARANCE');
        expect(await membershipStatusOf(orgMembershipId)).toBe('NONE');
        expect(await prisma.paymentException.count({ where: { kind: 'REVERSED_BEFORE_ACTIVATION', processId, severity: 'CRITICAL' } })).toBe(1);
        // Neither the welcome nor the payment-open notice goes to the family.
        expect(emailed('Welcome to the Treehouse')).toBe(false);
        expect(emailed('you can now pay your membership dues')).toBe(false);
    });

    it('a board override approve on a paid, blocked, refunded application holds instead of activating', async () => {
        const oid = orderId('Blk');
        const { processId, orgMembershipId, leadId } = await makeApplicant({ status: 'BLOCKED', paid: true, shopifyOrderId: oid });

        await raiseReversalByOrderId(oid, 'REFUND', [], `${oid}-r1`);
        await prisma.paymentException.updateMany({ where: { kind: 'REFUND', processId }, data: { status: 'RESOLVED', resolvedAt: new Date() } });

        await overrideBlocked(processId, board, 'approve', [leadId]);

        expect((await processOf(processId))?.status).toBe('PENDING_BG_CLEARANCE');
        expect(await membershipStatusOf(orgMembershipId)).toBe('NONE');
        expect(await prisma.paymentException.count({ where: { kind: 'REVERSED_BEFORE_ACTIVATION', processId, severity: 'CRITICAL' } })).toBe(1);
    });

    it('an unrefunded order still activates, on either path', async () => {
        const payFirst = await makeApplicant({ status: 'PENDING_PAYMENT', bgCleared: true });
        const { outcome } = await activateByProcessId(payFirst.processId, orderId('C1'), true);
        expect(outcome).toBe('active');
        expect(await membershipStatusOf(payFirst.orgMembershipId)).toBe('ACTIVE');

        const checkLast = await makeApplicant({ status: 'PENDING_BG_CLEARANCE', paid: true, shopifyOrderId: orderId('C2') });
        await attest(revA, checkLast.processId, { result: 'APPROVE', subjectPersonIds: [checkLast.leadId] });
        await attest(revB, checkLast.processId, { result: 'APPROVE', subjectPersonIds: [checkLast.leadId] });
        expect((await processOf(checkLast.processId))?.status).toBe('ACTIVE');
        expect(await membershipStatusOf(checkLast.orgMembershipId)).toBe('ACTIVE');
    });
});
