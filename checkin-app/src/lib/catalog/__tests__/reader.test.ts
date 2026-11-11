/**
 * @jest-environment node
 */
import { kindOf } from '@checkin/component-kit';
import { catalogReader } from '../reader';

jest.mock('@checkin/global-catalog', () => {
    // The catalog client's error when its database cannot be reached.
    const down = () => Promise.reject(Object.assign(new Error("Can't reach database server"), { code: 'P1001' }));
    return {
        readService: { listCategories: down, listSubcategories: down, getItem: down, getItemNames: down, getActiveItem: down, searchItems: down },
        referenceMatchingService: { lookupMany: down, checkReferences: down },
    };
});

async function failure(read: () => Promise<unknown>): Promise<unknown> {
    return read().then(
        () => { throw new Error('expected the read to fail'); },
        (err: unknown) => err,
    );
}

describe('catalogReader with the catalog database unreachable', () => {
    it.each<[string, () => Promise<unknown>]>([
        ['listCategories', () => catalogReader.listCategories()],
        ['listSubcategories', () => catalogReader.listSubcategories()],
        ['getItem', () => catalogReader.getItem('0022222222223')],
        ['getItemNames', () => catalogReader.getItemNames(['0022222222223'])],
        ['searchItems', () => catalogReader.searchItems('drill')],
        ['lookupItems', () => catalogReader.lookupItems('Hardware Co', [{ index: 0, partNumber: 'HB-1' }])],
        ['checkReferences', () => catalogReader.checkReferences({ retailer: 'Hardware Co', partNumber: 'HB-1' })],
        ['getActiveItem', () => catalogReader.getActiveItem('0022222222223')],
    ])('%s passes the failure up as a system failure', async (_method, read) => {
        expect(kindOf(await failure(read))).toBe('system');
    });

    it('rejects a malformed lookup instead of returning empty', async () => {
        await expect(catalogReader.lookupItems('Hardware Co', [{ index: 0.5 }])).rejects.toThrow();
    });
});
