/**
 * @jest-environment node
 */
/**
 * A refunded order never activates a program place; the app stops and raises it
 * to the Board, and a seat the refund restocked is taken back off sale.
 */
import { activateProgramEnrollment } from '@/lib/programs/activateEnrollment';
import { raiseReversalByOrderId } from '@/lib/finance/reconcile/reversals';
import prisma from '@/lib/prisma';
import { adjustProgramInventory } from '@/lib/shopify';
import { sendEmail } from '@/lib/email';

jest.mock('@/lib/shopify', () => ({
    adjustProgramInventory: jest.fn().mockResolvedValue(true),
    nudgeProgramStock: jest.fn(),
}));
jest.mock('@/lib/email', () => ({
    sendEmail: jest.fn().mockResolvedValue(true),
    runPaced: (tasks: Array<() => Promise<unknown>>) => Promise.all(tasks.map((t) => t())),
}));
const mockAdjust = adjustProgramInventory as jest.Mock;

const TAG = 'program-refund-gate-test';
const VARIANT = `variant-${TAG}`;
const orderId = (label: string) => `${TAG}-${label}-${Math.random().toString(36).slice(2)}`;

describe('a refunded order never activates a program place', () => {
    let programId: number;
    let householdId: number;
    let nextPerson = 0;

    async function pendingChild(): Promise<number> {
        const p = await prisma.person.create({ data: { name: `Child ${TAG}`, email: `child-${nextPerson++}-${TAG}@example.com`, householdId } });
        await prisma.programParticipant.create({ data: { programId, personId: p.id, status: 'PENDING', pendingSince: new Date() } });
        return p.id;
    }
    const statusOf = async (personId: number) =>
        (await prisma.programParticipant.findUniqueOrThrow({ where: { programId_personId: { programId, personId } } })).status;

    beforeAll(async () => {
        householdId = (await prisma.household.create({ data: { name: `HH ${TAG}` } })).id;
        // A board member to receive the CRITICAL email.
        await prisma.person.create({ data: { name: `Board ${TAG}`, email: `board-${TAG}@example.com`, isBoardMember: true, householdId } });
        programId = (await prisma.program.create({
            data: { startAt: new Date('2026-01-01'), endAt: new Date('2026-12-31'), name: `Program ${TAG}`, enrollmentStatus: 'OPEN', offSaleAt: new Date('2999-01-01'), shopifyVariantId: VARIANT, maxParticipants: 2 },
        })).id;
    });

    afterAll(async () => {
        await prisma.paymentException.deleteMany({ where: { shopifyOrderId: { startsWith: `${TAG}-` } } });
        for (const t of ['ShopifyOrderReversal', 'ShopifyRefundRestock']) {
            await prisma.auditLog.deleteMany({ where: { tableName: t, newData: { path: ['orderLegacyId'], string_starts_with: `${TAG}-` } } });
            await prisma.auditLog.deleteMany({ where: { tableName: t, newData: { path: ['shopifyOrderId'], string_starts_with: `${TAG}-` } } });
        }
        await prisma.auditLog.deleteMany({ where: { tableName: 'ShopifyRefundSettlement', secondaryAffectedEntity: programId } });
        await prisma.programParticipant.deleteMany({ where: { programId } });
        await prisma.program.delete({ where: { id: programId } });
        await prisma.person.deleteMany({ where: { householdId } });
        await prisma.household.delete({ where: { id: householdId } });
        await prisma.$disconnect();
    });

    beforeEach(() => jest.clearAllMocks());

    it('refund with restock before orders/paid: no activation, raised CRITICAL with email, seat taken back off sale', async () => {
        const oid = orderId('A');
        const child = await pendingChild();

        await raiseReversalByOrderId(oid, 'REFUND', [{ variantId: VARIANT, quantity: 1, lineQuantity: 1 }], `refund-${oid}`);
        const res = await activateProgramEnrollment({ programId, personIds: [child], shopifyOrderId: oid, lines: [{ variantId: VARIANT, quantity: 1 }] });

        expect(res).toEqual({ activatedCount: 0, releasedHoldCount: 0, claimantSeatCount: 0, reversed: true });
        expect(await statusOf(child)).toBe('PENDING');
        const raised = await prisma.paymentException.findMany({ where: { shopifyOrderId: oid } });
        expect(raised).toEqual([expect.objectContaining({ kind: 'REVERSED_BEFORE_ACTIVATION', severity: 'CRITICAL', status: 'OPEN', programId, personId: child })]);
        expect(sendEmail).toHaveBeenCalled();
        expect(mockAdjust).toHaveBeenCalledTimes(1);
        expect(mockAdjust).toHaveBeenCalledWith({ id: programId, shopifyVariantId: VARIANT }, -1, 'refund-before-activation', { deferred: true });

        // A redelivered orders/paid takes nothing back a second time.
        mockAdjust.mockClear();
        await activateProgramEnrollment({ programId, personIds: [child], shopifyOrderId: oid, lines: [{ variantId: VARIANT, quantity: 1 }] });
        expect(mockAdjust).not.toHaveBeenCalled();
        expect(await statusOf(child)).toBe('PENDING');
    });

    it('a resolved flag still blocks: the reversal ledger decides, not the open flag', async () => {
        const oid = orderId('B');
        const child = await pendingChild();

        await raiseReversalByOrderId(oid, 'REFUND');
        await activateProgramEnrollment({ programId, personIds: [child], shopifyOrderId: oid });
        await prisma.paymentException.updateMany({ where: { shopifyOrderId: oid }, data: { status: 'RESOLVED', resolvedAt: new Date() } });

        const res = await activateProgramEnrollment({ programId, personIds: [child], shopifyOrderId: oid });
        expect(res.reversed).toBe(true);
        expect(res.activatedCount).toBe(0);
        expect(await statusOf(child)).toBe('PENDING');
        const reopened = await prisma.paymentException.findFirstOrThrow({ where: { shopifyOrderId: oid, kind: 'REVERSED_BEFORE_ACTIVATION' } });
        expect(reopened.status).toBe('OPEN');
    });

    it('an unrefunded order still activates', async () => {
        const oid = orderId('C');
        const child = await pendingChild();

        const res = await activateProgramEnrollment({ programId, personIds: [child], shopifyOrderId: oid, lines: [{ variantId: VARIANT, quantity: 1 }] });
        expect(res).toEqual({ activatedCount: 1, releasedHoldCount: 0, claimantSeatCount: 0 });
        expect(await statusOf(child)).toBe('ACTIVE');
        expect(await prisma.paymentException.count({ where: { shopifyOrderId: oid } })).toBe(0);
    });
});
