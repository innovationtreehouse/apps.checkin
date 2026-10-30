/**
 * @jest-environment node
 */
/**
 * A refunded order never activates a program place; the app stops and raises it
 * to the Board, and a seat the refund restocked is taken back off sale.
 */
import { activateProgramEnrollment } from '@/lib/programs/activateEnrollment';
import { raiseReversalByOrderId } from '@/lib/finance/reconcile/reversals';
import { reconcileForwardProgram } from '@/lib/finance/reconcile/program';
import * as mirror from '@/lib/shopifyRead/client';
import type { MirrorOrder } from '@/lib/shopifyRead/client';
import prisma from '@/lib/prisma';
import { adjustProgramInventory } from '@/lib/shopify/stock';
import { sendEmail } from '@/lib/email';

jest.mock('@/lib/shopify/stock', () => ({
    adjustProgramInventory: jest.fn().mockResolvedValue(true),
    changeProgramStockWith: jest.fn((...a: unknown[]) => jest.requireActual('@/test-helpers/stockWith').forwardStockWith(...a)),
    nudgeProgramStock: jest.fn(),
}));
jest.mock('@/lib/shopifyRead/client', () => ({
    ...jest.requireActual('@/lib/shopifyRead/client'),
    orderLines: jest.fn(),
}));
jest.mock('@/lib/email', () => ({
    sendEmail: jest.fn().mockResolvedValue(true),
    runPaced: (tasks: Array<() => Promise<unknown>>) => Promise.all(tasks.map((t) => t())),
}));
const mockAdjust = adjustProgramInventory as jest.Mock;

const TAG = 'program-refund-gate-test';
const VARIANT = `variant-${TAG}`;
const CLAIMANT = `claimant-${TAG}`;
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
    /** A refunded order as the mirror shows it, its cart naming these children. */
    const refundedMirrorOrder = (oid: string, children: number[]): MirrorOrder => ({
        orderGid: `gid://shopify/Order/${oid}`, legacyId: oid, customerEmail: null, financialStatus: 'REFUNDED',
        totalCents: 10000, subtotalCents: 10000, totalRefundedCents: 10000, discountCents: 0, discountCodes: [],
        processedAt: null, cancelledAt: null, updatedAt: new Date(),
        noteAttributes: [{ key: 'Program_ID', value: String(programId) }, { key: 'CheckMeIn_Account_ID', value: children.join(',') }],
    });
    const statusOf = async (personId: number) =>
        (await prisma.programParticipant.findUniqueOrThrow({ where: { programId_personId: { programId, personId } } })).status;

    beforeAll(async () => {
        householdId = (await prisma.household.create({ data: { name: `HH ${TAG}` } })).id;
        // A board member to receive the CRITICAL email.
        await prisma.person.create({ data: { name: `Board ${TAG}`, email: `board-${TAG}@example.com`, isBoardMember: true, householdId } });
        programId = (await prisma.program.create({
            data: { appliesToYear: 2026, startAt: new Date('2026-01-01'), endAt: new Date('2026-12-31'), name: `Program ${TAG}`, enrollmentStatus: 'OPEN', offSaleAt: new Date('2999-01-01'), shopifyVariantId: VARIANT, claimantShopifyVariantId: CLAIMANT, maxParticipants: 2 },
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

    it('concurrent deliveries of one refund record its restock once, so the take-back is not doubled', async () => {
        const oid = orderId('D');
        const child = await pendingChild();
        const restock = [{ variantId: VARIANT, quantity: 1, lineQuantity: 1 }];

        await Promise.all([1, 2, 3].map(() => raiseReversalByOrderId(oid, 'REFUND', restock, `refund-${oid}`)));
        expect(await prisma.auditLog.count({ where: { tableName: 'ShopifyRefundRestock', newData: { path: ['orderLegacyId'], equals: oid } } })).toBe(1);

        await activateProgramEnrollment({ programId, personIds: [child], shopifyOrderId: oid });
        expect(mockAdjust).toHaveBeenCalledTimes(1);
        expect(mockAdjust).toHaveBeenCalledWith({ id: programId, shopifyVariantId: VARIANT }, -1, 'refund-before-activation', { deferred: true });
    });

    it('a restock on the reserved-seat item takes nothing back, but still raises the child', async () => {
        const oid = orderId('E');
        const child = await pendingChild();

        await raiseReversalByOrderId(oid, 'REFUND', [{ variantId: CLAIMANT, quantity: 1, lineQuantity: 1 }], `refund-${oid}`);
        const res = await activateProgramEnrollment({ programId, personIds: [child], shopifyOrderId: oid, lines: [{ variantId: CLAIMANT, quantity: 1 }] });

        expect(res.reversed).toBe(true);
        expect(mockAdjust).not.toHaveBeenCalled();
        expect(await prisma.paymentException.count({ where: { shopifyOrderId: oid, personId: child, severity: 'CRITICAL' } })).toBe(1);
    });

    it('missed orders/paid: the reconciler refuses through the same gate, every child CRITICAL, restock taken back', async () => {
        const oid = orderId('F');
        const a = await pendingChild();
        const b = await pendingChild();
        (mirror.orderLines as jest.Mock).mockResolvedValue([{ variantId: VARIANT, quantity: 2, currentQuantity: 2 }]);

        await raiseReversalByOrderId(oid, 'REFUND', [{ variantId: VARIANT, quantity: 2, lineQuantity: 2 }], `refund-${oid}`);
        expect(await reconcileForwardProgram(refundedMirrorOrder(oid, [a, b]))).toBe(true);

        expect(await statusOf(a)).toBe('PENDING');
        expect(await statusOf(b)).toBe('PENDING');
        const raised = await prisma.paymentException.findMany({ where: { shopifyOrderId: oid, kind: 'REVERSED_BEFORE_ACTIVATION' }, orderBy: { personId: 'asc' } });
        expect(raised.map((r) => [r.personId, r.severity])).toEqual([[a, 'CRITICAL'], [b, 'CRITICAL']]);
        expect(mockAdjust).toHaveBeenCalledTimes(1);
        expect(mockAdjust).toHaveBeenCalledWith({ id: programId, shopifyVariantId: VARIANT }, -2, 'refund-before-activation', { deferred: true });
    });

    it('a reversal only the reconciler saw is written to the ledger, so a late orders/paid stays refused after the flag is resolved', async () => {
        const oid = orderId('G');
        const child = await pendingChild();
        (mirror.orderLines as jest.Mock).mockResolvedValue([{ variantId: VARIANT, quantity: 1, currentQuantity: 1 }]);

        await reconcileForwardProgram(refundedMirrorOrder(oid, [child]));
        await prisma.paymentException.updateMany({ where: { shopifyOrderId: oid }, data: { status: 'RESOLVED', resolvedAt: new Date() } });

        const res = await activateProgramEnrollment({ programId, personIds: [child], shopifyOrderId: oid, lines: [{ variantId: VARIANT, quantity: 1 }] });
        expect(res.reversed).toBe(true);
        expect(await statusOf(child)).toBe('PENDING');
    });
});
