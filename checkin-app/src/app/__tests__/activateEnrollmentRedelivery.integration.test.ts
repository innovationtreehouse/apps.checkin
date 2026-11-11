/**
 * @jest-environment node
 */
/**
 * Focused test for the T4 activate (PROGRAM_ENROLLMENT_STATE_MACHINE §7).
 *
 * activateProgramEnrollment does the PENDING→ACTIVE status flip and the hold
 * release as ONE atomic updateMany (status:ACTIVE + inventoryHeldAt:null together).
 * Two steps would commit the row as ACTIVE-with-held between them — an I1 violation,
 * and a crash window that strands a −1 that never comes back.
 *
 * This asserts the post-condition (ACTIVE, held null, validates clean — no I1),
 * that the compensating Shopify +1 is exactly right for a held row, and that a
 * webhook REDELIVERY (a second call) is a no-op: no double-activate, no double
 * +1 — the single status:'PENDING' guard matches 0 rows the second time.
 *
 * adjustProgramInventory is mocked so the +1 call count is asserted directly.
 */
import { activateProgramEnrollment } from '@/lib/programs/activateEnrollment';
import prisma from '@/lib/prisma';
import { toRow, classify, validate } from '@/lib/programs/enrollmentState';
import { adjustProgramInventory } from '@/lib/shopify/stock';

jest.mock('@/lib/shopify/stock', () => ({
    adjustProgramInventory: jest.fn().mockResolvedValue(true),
    changeProgramStockWith: jest.fn((...a: unknown[]) => jest.requireActual('@/test-helpers/stockWith').forwardStockWith(...a)),
}));
const mockAdjust = adjustProgramInventory as jest.Mock;

const TAG = 'activate-redelivery-test';

describe('activateProgramEnrollment — atomic collapse + redelivery no-op', () => {
    let programId: number;
    let personId: number;

    beforeAll(async () => {
        const person = await prisma.person.create({
            data: { name: 'Redelivery Self', email: `self-${TAG}@example.com`, household: { create: { name: 'HH' } } },
        });
        personId = person.id;
        // Single-pool (shopifyVariantId present).
        const program = await prisma.program.create({
            data: { appliesToYear: 2026, startAt: new Date('2026-01-01'), endAt: new Date('2026-12-31'), name: `Redelivery Program ${TAG}`, enrollmentStatus: 'OPEN', offSaleAt: new Date('2999-01-01'), shopifyVariantId: 'dev-mock-variant-redeliv' },
        });
        programId = program.id;
    });

    afterAll(async () => {
        await prisma.programParticipant.deleteMany({ where: { programId } });
        await prisma.program.delete({ where: { id: programId } });
        const p = await prisma.person.findUniqueOrThrow({ where: { id: personId }, select: { householdId: true } });
        await prisma.person.delete({ where: { id: personId } });
        await prisma.household.delete({ where: { id: p.householdId } });
    });

    beforeEach(() => jest.clearAllMocks());

    it('activates a held PENDING row → ACTIVE + held null (clean, no I1), +1 fired once; redelivery is a no-op', async () => {
        // Seed PENDING_HELD (a seat held): the −1 landed at apply time.
        await prisma.programParticipant.upsert({
            where: { programId_personId: { programId, personId } },
            update: { status: 'PENDING', isPaymentPlanRequested: true, inventoryHeldAt: new Date(), paymentPlanDeniedAt: null, pendingSince: new Date() },
            create: { programId, personId, status: 'PENDING', isPaymentPlanRequested: true, inventoryHeldAt: new Date(), pendingSince: new Date() },
        });

        // First activation (the paid webhook).
        const first = await activateProgramEnrollment({
            programId, personIds: [personId], shopifyOrderId: 'order-redeliv-1',
        });
        expect(first).toEqual({ activatedCount: 1, releasedHoldCount: 1, claimantSeatCount: 0 });

        // Post-condition: ACTIVE with the hold released in the SAME write — never ACTIVE+held.
        const db = await prisma.programParticipant.findUniqueOrThrow({ where: { programId_personId: { programId, personId } } });
        expect(db.status).toBe('ACTIVE');
        expect(db.inventoryHeldAt).toBeNull(); // raw column cleared in the atomic flip
        const row = toRow(db);
        expect(classify(row)).toBe('ACTIVE');
        expect(validate(row)).toBeNull(); // no I1

        // Exactly one compensating +1 for the one released hold.
        expect(mockAdjust).toHaveBeenCalledTimes(1);
        expect(mockAdjust).toHaveBeenCalledWith(expect.anything(), 1, 'activation', { deferred: true });

        mockAdjust.mockClear();

        // Redelivery: same order arrives again. Guard finds the row already ACTIVE.
        const second = await activateProgramEnrollment({
            programId, personIds: [personId], shopifyOrderId: 'order-redeliv-1',
        });
        expect(second).toEqual({ activatedCount: 0, releasedHoldCount: 0, claimantSeatCount: 0 }); // no double-activate, no double-release
        expect(mockAdjust).not.toHaveBeenCalled();                            // no double +1

        // Row unchanged: still ACTIVE, still clean.
        const db2 = await prisma.programParticipant.findUniqueOrThrow({ where: { programId_personId: { programId, personId } } });
        expect(db2.status).toBe('ACTIVE');
        expect(db2.inventoryHeldAt).toBeNull();
        expect(validate(toRow(db2))).toBeNull();
    });

    it('releases the hold without a +1 once the sale has ended', async () => {
        await prisma.program.update({ where: { id: programId }, data: { saleEndedAt: new Date() } });
        try {
            await prisma.programParticipant.upsert({
                where: { programId_personId: { programId, personId } },
                update: { status: 'PENDING', isPaymentPlanRequested: true, inventoryHeldAt: new Date(), paymentPlanDeniedAt: null, pendingSince: new Date() },
                create: { programId, personId, status: 'PENDING', isPaymentPlanRequested: true, inventoryHeldAt: new Date(), pendingSince: new Date() },
            });

            const result = await activateProgramEnrollment({ programId, personIds: [personId], shopifyOrderId: 'order-redeliv-ended' });
            expect(result).toEqual({ activatedCount: 1, releasedHoldCount: 1, claimantSeatCount: 0 });
            expect(mockAdjust).not.toHaveBeenCalled();
        } finally {
            await prisma.program.update({ where: { id: programId }, data: { saleEndedAt: null } });
        }
    });

    it('still takes a claimant-paid unheld seat out of public stock (-1) after the sale has ended', async () => {
        await prisma.program.update({
            where: { id: programId },
            data: { saleEndedAt: new Date(), maxParticipants: 10, claimantShopifyVariantId: 'dev-mock-claimant-redeliv' },
        });
        try {
            await prisma.programParticipant.upsert({
                where: { programId_personId: { programId, personId } },
                update: { status: 'PENDING', isPaymentPlanRequested: false, inventoryHeldAt: null, paymentPlanDeniedAt: null, pendingSince: new Date() },
                create: { programId, personId, status: 'PENDING', pendingSince: new Date() },
            });

            const result = await activateProgramEnrollment({
                programId, personIds: [personId], shopifyOrderId: 'order-redeliv-claimant-ended',
                lines: [{ variantId: 'dev-mock-claimant-redeliv', quantity: 1 }],
            });
            expect(result).toEqual({ activatedCount: 1, releasedHoldCount: 0, claimantSeatCount: 1 });
            expect(mockAdjust).toHaveBeenCalledTimes(1);
            expect(mockAdjust).toHaveBeenCalledWith(expect.objectContaining({ shopifyVariantId: 'dev-mock-variant-redeliv' }), -1, 'activation', { deferred: true });
        } finally {
            await prisma.program.update({
                where: { id: programId },
                data: { saleEndedAt: null, maxParticipants: null, claimantShopifyVariantId: null },
            });
        }
    });
});
