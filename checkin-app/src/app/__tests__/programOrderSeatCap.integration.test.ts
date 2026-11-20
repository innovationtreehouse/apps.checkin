/**
 * @jest-environment node
 */
/**
 * One order seat seats one person, whichever writers race for it. The order is
 * judged before its lock is taken, so the count that decides is the one under the lock.
 */
import { activateProgramEnrollment } from '@/lib/programs/activateEnrollment';
import prisma from '@/lib/prisma';

jest.mock('@/lib/email', () => ({
    sendEmail: jest.fn().mockResolvedValue(true),
    runPaced: (tasks: Array<() => Promise<unknown>>) => Promise.all(tasks.map((t) => t())),
}));

const TAG = 'program-order-seat-cap-test';
const VARIANT = `variant-${TAG}`;
const LINES = [{ variantId: VARIANT, quantity: 1, currentQuantity: 1 }];
const orderId = (label: string) => `${TAG}-${label}-${Math.random().toString(36).slice(2)}`;

describe('an order seat activates one person', () => {
    let programId: number;
    let householdId: number;
    let nextPerson = 0;

    async function pendingChild(): Promise<number> {
        const p = await prisma.person.create({ data: { name: `Child ${TAG}`, email: `child-${nextPerson++}-${TAG}@example.com`, householdId } });
        await prisma.programParticipant.create({ data: { programId, personId: p.id, status: 'PENDING', pendingSince: new Date() } });
        return p.id;
    }
    const activeOn = (oid: string) => prisma.programParticipant.count({ where: { programId, shopifyOrderId: oid, status: 'ACTIVE' } });

    beforeAll(async () => {
        householdId = (await prisma.household.create({ data: { name: `HH ${TAG}` } })).id;
        programId = (await prisma.program.create({
            data: { appliesToYear: 2026, startAt: new Date('2026-01-01'), endAt: new Date('2026-12-31'), name: `Program ${TAG}`, enrollmentStatus: 'OPEN', offSaleAt: new Date('2999-01-01'), shopifyVariantId: VARIANT, maxParticipants: 10 },
        })).id;
    });

    afterAll(async () => {
        await prisma.paymentException.deleteMany({ where: { shopifyOrderId: { startsWith: `${TAG}-` } } });
        await prisma.programParticipant.deleteMany({ where: { programId } });
        await prisma.program.delete({ where: { id: programId } });
        await prisma.person.deleteMany({ where: { householdId } });
        await prisma.household.delete({ where: { id: householdId } });
        await prisma.$disconnect();
    });

    it('a seat spent between the judgement and the activation seats nobody else, and the Board hears of it', async () => {
        const oid = orderId('spent-between');
        const child = await pendingChild();
        const sibling = await pendingChild();
        // Another writer seats the sibling on the order after the webhook judged it.
        await prisma.programParticipant.update({
            where: { programId_personId: { programId, personId: sibling } },
            data: { status: 'ACTIVE', shopifyOrderId: oid, pendingSince: null },
        });

        const res = await activateProgramEnrollment({ programId, personIds: [child], shopifyOrderId: oid, lines: LINES });

        expect(res).toMatchObject({ activatedCount: 0, refusedPersonIds: [child] });
        expect(await activeOn(oid)).toBe(1);
        expect(await prisma.paymentException.findMany({ where: { shopifyOrderId: oid } })).toEqual([
            expect.objectContaining({ kind: 'AMOUNT_MISMATCH', programId, personId: child }),
        ]);
    });

    it('two activations of one order naming different people seat exactly one', async () => {
        const oid = orderId('two-writers');
        const a = await pendingChild();
        const b = await pendingChild();

        const results = await Promise.all([
            activateProgramEnrollment({ programId, personIds: [a], shopifyOrderId: oid, lines: LINES }),
            activateProgramEnrollment({ programId, personIds: [b], shopifyOrderId: oid, lines: LINES }),
        ]);

        expect(results.map((r) => r.activatedCount).sort()).toEqual([0, 1]);
        expect(await activeOn(oid)).toBe(1);
    });

    it('a sibling approved by the Board between the judgement and the flip leaves a paid seat, raised as a duplicate', async () => {
        const oid = orderId('approved-between');
        const a = await pendingChild();
        const b = await pendingChild();
        await prisma.programParticipant.updateMany({
            where: { programId, personId: { in: [a, b] } },
            data: { isPaymentPlanRequested: true, inventoryHeldAt: new Date() },
        });
        // The daily check judged one order paying for both while both were pending; then the Board approves a.
        await prisma.programParticipant.update({
            where: { programId_personId: { programId, personId: a } },
            data: { status: 'ACTIVE', isPaymentPlanRequested: false, inventoryHeldAt: null, seatTakenWithoutSaleAt: new Date() },
        });

        const res = await activateProgramEnrollment({ programId, personIds: [a, b], shopifyOrderId: oid, lines: [{ ...LINES[0], quantity: 2, currentQuantity: 2 }] });

        expect(res.activatedCount).toBe(1);
        expect(await activeOn(oid)).toBe(1);
        expect(await prisma.paymentException.findMany({ where: { shopifyOrderId: oid } })).toEqual([
            expect.objectContaining({ kind: 'DUPLICATE_PAYMENT', programId, personId: a }),
        ]);
    });

    it('a redelivery of the same order for the same person changes nothing and raises nothing', async () => {
        const oid = orderId('redelivery');
        const child = await pendingChild();

        await activateProgramEnrollment({ programId, personIds: [child], shopifyOrderId: oid, lines: LINES });
        const again = await activateProgramEnrollment({ programId, personIds: [child], shopifyOrderId: oid, lines: LINES });

        expect(again.activatedCount).toBe(0);
        expect(await activeOn(oid)).toBe(1);
        expect(await prisma.paymentException.count({ where: { shopifyOrderId: oid } })).toBe(0);
    });
});
