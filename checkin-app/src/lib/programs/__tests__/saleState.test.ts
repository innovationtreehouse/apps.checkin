import { classify, enrollmentClosedBy, isSaleEnded, effectiveOffSaleAt, saleStockDelta, type SaleRow } from '@/lib/programs/saleState';
import { calendarDayIn } from '@/lib/time';

const TODAY = new Date('2026-10-12');
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
        expect(classify(row(), TODAY)).toBe('ON_SALE');
        expect(classify(row({ enrollmentStatus: 'CLOSED' }), TODAY)).toBe('NOT_ON_SALE');
    });

    it('ends the sale on the off-sale date, before or after the start', () => {
        expect(classify(row({ offSaleAt: new Date('2026-10-12') }), TODAY)).toBe('SALE_ENDED');
        expect(classify(row({ startAt: new Date('2026-10-01'), offSaleAt: new Date('2026-10-20') }), TODAY)).toBe('ON_SALE');
        expect(classify(row({ startAt: new Date('2026-10-01') }), TODAY)).toBe('SALE_ENDED');
    });

    it('treats a row loaded without the sale fields as still on sale', () => {
        // A Prisma select (or test mock) that omits the fields yields undefined at runtime.
        const partial: Partial<SaleRow> = { phase: 'UPCOMING', enrollmentStatus: 'OPEN' };
        expect(isSaleEnded(partial as SaleRow, TODAY)).toBe(false);
        expect(isSaleEnded({ startAt: new Date('2026-11-01') } as SaleRow, TODAY)).toBe(false);
    });

    it('after the sale ends, a stock change may only reduce', () => {
        const ended = row({ saleEndedAt: new Date('2026-10-01') });
        expect(saleStockDelta(ended, 1, TODAY)).toBe(0);
        expect(saleStockDelta(ended, -1, TODAY)).toBe(-1);
        expect(saleStockDelta(row(), 2, TODAY)).toBe(2);
    });

    it('stays ended once the sweep stamped it, and FINISHED wins', () => {
        expect(isSaleEnded(row({ saleEndedAt: new Date('2026-10-01') }), TODAY)).toBe(true);
        expect(classify(row({ phase: 'FINISHED' }), TODAY)).toBe('FINISHED');
    });
});

describe('enrollmentClosedBy', () => {
    const open = { ...row(), maxParticipants: 10 };

    it('is null for an open program with seats before its off-sale date', () => {
        expect(enrollmentClosedBy(open, 3, TODAY)).toBeNull();
        expect(enrollmentClosedBy({ ...open, maxParticipants: null }, 99, TODAY)).toBeNull();
    });

    it('closes a full program, ahead of every other cause', () => {
        expect(enrollmentClosedBy(open, 10, TODAY)).toBe('FULL');
        expect(enrollmentClosedBy({ ...open, enrollmentStatus: 'CLOSED', offSaleAt: new Date('2026-10-01') }, 10, TODAY)).toBe('FULL');
    });

    it('never reads an unknown count as full', () => {
        expect(enrollmentClosedBy({ ...open, maxParticipants: 0 }, undefined, TODAY)).toBeNull();
    });

    it('closes once the sale has ended, by date or by the sweep', () => {
        expect(enrollmentClosedBy({ ...open, offSaleAt: new Date('2026-10-12') }, 0, TODAY)).toBe('SALE_ENDED');
        expect(enrollmentClosedBy({ ...open, startAt: new Date('2026-10-01') }, 0, TODAY)).toBe('SALE_ENDED');
        expect(enrollmentClosedBy({ ...open, saleEndedAt: new Date('2026-10-11') }, 0, TODAY)).toBe('SALE_ENDED');
    });

    it('closes when enrollment is closed by hand', () => {
        expect(enrollmentClosedBy({ ...open, enrollmentStatus: 'CLOSED' }, 0, TODAY)).toBe('CLOSED');
    });
});

describe("the org's day decides", () => {
    // 11:30 PM on the 11th in Chicago, 12:30 AM on the 12th in New York.
    const instant = new Date('2026-10-12T04:30:00Z');
    const newYork = calendarDayIn(instant, 'America/New_York');
    const chicago = calendarDayIn(instant, 'America/Chicago');
    const endsOn12th = row({ offSaleAt: new Date('2026-10-12') });

    it('ends a sale on its off-sale date in the org zone, not a fixed one', () => {
        expect(isSaleEnded(endsOn12th, newYork)).toBe(true);
        expect(isSaleEnded(endsOn12th, chicago)).toBe(false);
        expect(classify(endsOn12th, newYork)).toBe('SALE_ENDED');
        expect(classify(endsOn12th, chicago)).toBe('ON_SALE');
    });

    it('closes claims and stops restocks on that same day', () => {
        expect(enrollmentClosedBy({ ...endsOn12th, maxParticipants: 10 }, 0, newYork)).toBe('SALE_ENDED');
        expect(enrollmentClosedBy({ ...endsOn12th, maxParticipants: 10 }, 0, chicago)).toBeNull();
        expect(saleStockDelta(endsOn12th, 1, newYork)).toBe(0);
        expect(saleStockDelta(endsOn12th, 1, chicago)).toBe(1);
    });
});
