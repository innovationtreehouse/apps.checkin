/**
 * @jest-environment node
 */
import { catalogReader } from '../reader';

jest.mock('@inventory/global-catalog', () => {
    const down = () => Promise.reject(new Error('connect ECONNREFUSED'));
    return {
        readService: { listCategories: down, listSubcategories: down, getItem: down },
        referenceMatchingService: { lookupMany: down, checkReferences: down },
    };
});

beforeEach(() => jest.spyOn(console, 'warn').mockImplementation(() => undefined));
afterEach(() => jest.restoreAllMocks());

describe('catalogReader with the catalog unreachable', () => {
    it('falls back to the inert result for display reads', async () => {
        expect(await catalogReader.listCategories()).toEqual([]);
        expect(await catalogReader.listSubcategories()).toEqual([]);
        expect(await catalogReader.getItem('0022222222223')).toBeNull();
        expect(await catalogReader.lookupItems('Hardware Co', [{ index: 0, partNumber: 'HB-1' }])).toEqual([]);
        expect(console.warn).toHaveBeenCalledTimes(4);
    });

    it('fails closed on the reference check, never reporting all-not-found', async () => {
        await expect(catalogReader.checkReferences({ retailer: 'Hardware Co', partNumber: 'HB-1' })).rejects.toThrow(
            'ECONNREFUSED',
        );
    });

    it('rejects a malformed lookup instead of returning empty', async () => {
        await expect(catalogReader.lookupItems('Hardware Co', [{ index: 0.5 }])).rejects.toThrow();
    });
});
