import { classify, isSaleEnded, effectiveOffSaleAt, saleStockDelta, type SaleRow } from '@/lib/programs/saleState';

const NOW = new Date('2026-10-12T15:00:00Z');
const row = (over: Partial<SaleRow> = {}): SaleRow => ({
    phase: 'UPCOMING',
    enrollmentStatus: 'OPEN',
    startAt: new Date('2026-11-01'),
    offSaleAt: null,
    saleEndedAt: null,
    ...over,
});

describe('program sale state', () => {
    it('defaults the off-sale date to the start date', () => {
        expect(effectiveOffSaleAt(row())).toEqual(new Date('2026-11-01'));
        expect(effectiveOffSaleAt(row({ offSaleAt: new Date('2026-12-01') }))).toEqual(new Date('2026-12-01'));
    });

    it('is ON_SALE when open and before the off-sale date, NOT_ON_SALE when paused', () => {
        expect(classify(row(), NOW)).toBe('ON_SALE');
        expect(classify(row({ enrollmentStatus: 'CLOSED' }), NOW)).toBe('NOT_ON_SALE');
    });

    it('ends the sale on the off-sale date, before or after the start', () => {
        expect(classify(row({ offSaleAt: new Date('2026-10-12') }), NOW)).toBe('SALE_ENDED');
        expect(classify(row({ startAt: new Date('2026-10-01'), offSaleAt: new Date('2026-10-20') }), NOW)).toBe('ON_SALE');
        expect(classify(row({ startAt: new Date('2026-10-01') }), NOW)).toBe('SALE_ENDED');
    });

    it('treats a row loaded without the sale fields as still on sale', () => {
        // A Prisma select (or test mock) that omits the fields yields undefined at runtime.
        const partial: Partial<SaleRow> = { phase: 'UPCOMING', enrollmentStatus: 'OPEN' };
        expect(isSaleEnded(partial as SaleRow, NOW)).toBe(false);
        expect(isSaleEnded({ startAt: new Date('2026-11-01') } as SaleRow, NOW)).toBe(false);
    });

    it('after the sale ends, a stock change may only reduce', () => {
        const ended = row({ saleEndedAt: new Date('2026-10-01') });
        expect(saleStockDelta(ended, 1, NOW)).toBe(0);
        expect(saleStockDelta(ended, -1, NOW)).toBe(-1);
        expect(saleStockDelta(row(), 2, NOW)).toBe(2);
    });

    it('stays ended once the sweep stamped it, and FINISHED wins', () => {
        expect(isSaleEnded(row({ saleEndedAt: new Date('2026-10-01') }), NOW)).toBe(true);
        expect(classify(row({ phase: 'FINISHED' }), NOW)).toBe('FINISHED');
    });
});
