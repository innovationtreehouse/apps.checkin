/**
 * @jest-environment node
 */
import prisma from '@/lib/prisma';
import { runSaleSweep } from '@/lib/programs/saleSweep';
import { orgToday } from '@/lib/appSettings';
import { calendarDayIn } from '@/lib/time';

jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    default: { program: { findMany: jest.fn().mockResolvedValue([]), updateMany: jest.fn() } },
}));
jest.mock('@/lib/appSettings', () => ({ orgToday: jest.fn() }));
jest.mock('@/lib/programs/storeClosed', () => ({ isProgramStoreClosed: jest.fn().mockResolvedValue(false) }));
jest.mock('@/lib/shopify/stock', () => ({ setProgramProductOffSale: jest.fn() }));
jest.mock('@/lib/shopify/client', () => ({ reportShopifyFailure: jest.fn() }));
jest.mock('@/lib/emailRecipients', () => ({ emailBoardMembers: jest.fn() }));

const findMany = jest.mocked(prisma.program.findMany);

// 11:30 PM on the 11th in Chicago, 12:30 AM on the 12th in New York.
const NOW = new Date('2026-10-12T04:30:00Z');

describe('the sale sweep reads the day in the org zone', () => {
    it.each([
        ['America/New_York', '2026-10-12'],
        ['America/Chicago', '2026-10-11'],
    ])('in %s it ends sales due on or before %s', async (zone, day) => {
        jest.mocked(orgToday).mockImplementation(async (now = new Date()) => calendarDayIn(now, zone));
        await runSaleSweep(NOW);
        expect(orgToday).toHaveBeenCalledWith(NOW);
        const bound = new Date(`${day}T00:00:00Z`);
        expect(findMany.mock.calls[0][0]).toMatchObject({
            where: { saleEndedAt: null, OR: [{ offSaleAt: { lte: bound } }, { offSaleAt: null, startAt: { lte: bound } }] },
        });
        findMany.mockClear();
    });
});
