/**
 * @jest-environment node
 */
import prisma from '@/lib/prisma';
import { config, DEV_MOCK_MEMBERSHIP_VARIANT_ID } from '@/lib/config';
import { liveYearVariantId } from '@/lib/membership/payment';

jest.mock('@/lib/prisma', () => ({ __esModule: true, default: { membershipYearVariant: { findUnique: jest.fn() } } }));

const findUnique = prisma.membershipYearVariant.findUnique as jest.Mock;
const boundary = new Date('2000-09-01T00:00:00.000Z');
const offSeason = new Date('2026-11-01T00:00:00.000Z');
const inWindow = new Date('2027-07-15T00:00:00.000Z');

describe('liveYearVariantId', () => {
    let mockActive: jest.SpyInstance;
    beforeEach(() => {
        findUnique.mockReset();
        mockActive = jest.spyOn(config, 'shopifyMockActive').mockReturnValue(false);
    });
    afterEach(() => mockActive.mockRestore());

    it("sells the live year's row, the year in progress off season", async () => {
        findUnique.mockResolvedValue({ shopifyVariantId: '111' });
        await expect(liveYearVariantId(boundary, offSeason)).resolves.toBe('111');
        expect(findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { membershipYear: 2026 } }));
    });

    it('sells the coming year from the day the renewal window opens', async () => {
        findUnique.mockResolvedValue({ shopifyVariantId: '222' });
        await expect(liveYearVariantId(boundary, inWindow)).resolves.toBe('222');
        expect(findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { membershipYear: 2027 } }));
    });

    it('sells nothing when the live year has no row', async () => {
        findUnique.mockResolvedValue(null);
        await expect(liveYearVariantId(boundary, offSeason)).resolves.toBeNull();
    });

    it('sells nothing with no boundary', async () => {
        await expect(liveYearVariantId(null, offSeason)).resolves.toBeNull();
        expect(findUnique).not.toHaveBeenCalled();
    });

    it('sells the mock variant when the mock is active and the live year has no row', async () => {
        mockActive.mockReturnValue(true);
        findUnique.mockResolvedValue(null);
        await expect(liveYearVariantId(boundary, offSeason)).resolves.toBe(DEV_MOCK_MEMBERSHIP_VARIANT_ID);
        await expect(liveYearVariantId(null, offSeason)).resolves.toBe(DEV_MOCK_MEMBERSHIP_VARIANT_ID);
    });

    it("prefers the live year's row over the mock variant", async () => {
        mockActive.mockReturnValue(true);
        findUnique.mockResolvedValue({ shopifyVariantId: '111' });
        await expect(liveYearVariantId(boundary, offSeason)).resolves.toBe('111');
    });
});
