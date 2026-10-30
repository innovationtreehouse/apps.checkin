/**
 * @jest-environment node
 */
/**
 * adjustProgramInventory pushes a program's stock under a per-program lease
 * (Program.shopifyStockLeaseUntil/Token), so two writers never interleave read and
 * write, and no DB transaction stays open across a Shopify call. Runs on the
 * CHECKIN_ENV=local Shopify mock (no network) against a real Postgres.
 */
import prisma from '@/lib/prisma';
import { adjustProgramInventory, programStockTiming } from '@/lib/shopify/stock';

const TAG = 'program-stock-lock-concurrency-test';

describe('program stock writer: one writer per program', () => {
    let prevCheckinEnv: string | undefined;
    let programId: number;
    let variantId: string;
    let logSpy: jest.SpyInstance;

    beforeAll(async () => {
        prevCheckinEnv = process.env.CHECKIN_ENV;
        process.env.CHECKIN_ENV = 'local';
        variantId = `dev-mock-variant-${TAG}-${Date.now()}`;
        const program = await prisma.program.create({
            // Still on sale, so the drain doesn't drop the +5 (sale-ended rule).
            data: { appliesToYear: 2026, name: TAG, startAt: new Date('2026-01-01'), endAt: new Date('2026-12-31'), offSaleAt: new Date('2999-01-01'), maxParticipants: 5, shopifyVariantId: variantId },
        });
        programId = program.id;
    });

    afterAll(async () => {
        process.env.CHECKIN_ENV = prevCheckinEnv;
        await prisma.program.deleteMany({ where: { name: TAG } });
    });

    beforeEach(() => {
        logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    });

    afterEach(() => logSpy.mockRestore());

    const stockLines = () => logSpy.mock.calls.map((c) => String(c[0])).filter((l) => l.includes(`Program ${programId} stock`));

    it('a writer waits while another holds the lease, then lands its delta', async () => {
        await prisma.program.update({
            where: { id: programId },
            data: { shopifyStockLeaseUntil: new Date(Date.now() + 1_000), shopifyStockLeaseToken: 'other-writer' },
        });

        const pending = adjustProgramInventory({ id: programId, shopifyVariantId: variantId }, 5, 'initial-stock', { inRequest: true });
        await new Promise((r) => setTimeout(r, 400));
        expect(stockLines()).toEqual([]); // still waiting: nothing read or written
        expect((await prisma.program.findUnique({ where: { id: programId } }))?.shopifyStockCarry).toBe(5); // recorded as owed

        expect(await pending).toBe(true);
        expect(stockLines()).toEqual([expect.stringContaining('0 -> 5')]);
    });

    it('two concurrent writers both land, serialized, with no compare-and-set retry', async () => {
        const prevCap = programStockTiming.requestCapMs;
        programStockTiming.requestCapMs = 10_000;
        try {
            const results = await Promise.all([
                adjustProgramInventory({ id: programId, shopifyVariantId: variantId }, -1, 'comp', { inRequest: true }),
                adjustProgramInventory({ id: programId, shopifyVariantId: variantId }, -2, 'comp', { inRequest: true }),
            ]);
            expect(results).toEqual([true, true]);
        } finally {
            programStockTiming.requestCapMs = prevCap;
        }

        expect(stockLines().some((l) => l.includes('mismatch'))).toBe(false);
        // Whichever writer held the lease landed both deltas, in one write or two: 5 − 1 − 2.
        expect(stockLines()[stockLines().length - 1]).toContain('-> 2');
        const row = await prisma.program.findUnique({ where: { id: programId } });
        expect(row).toMatchObject({
            shopifyStockCarry: 0,
            shopifyStockUnconfirmed: 0,
            shopifyStockPendingWrite: null,
            shopifyStockPushNeededAt: null,
            shopifyStockLeaseToken: null,
        });
    });
});
