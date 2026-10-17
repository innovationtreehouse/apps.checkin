/**
 * @jest-environment node
 */
import { createCatalogSubmissions } from '../submissions';

const createItemReferenceProposal = jest.fn();
const reportConflict = jest.fn();
const allocateNextProvisionalGtin = jest.fn();
const createProvisionalItem = jest.fn();
jest.mock('@checkin/global-catalog', () => ({
    proposalService: { createItemReferenceProposal: (...a: unknown[]) => createItemReferenceProposal(...a) },
    conflictResolutionService: { reportConflict: (...a: unknown[]) => reportConflict(...a) },
    provisionalGtinService: {
        allocateNextProvisionalGtin: (...a: unknown[]) => allocateNextProvisionalGtin(...a),
        createProvisionalItem: (...a: unknown[]) => createProvisionalItem(...a),
    },
}));

const submissions = createCatalogSubmissions(async () => ({ id: 'treehouse', name: 'Treehouse' }));

beforeEach(() => jest.resetAllMocks());

describe('catalog submissions bound to the catalog', () => {
    it('stamps the org on a reference proposal and returns only its id', async () => {
        createItemReferenceProposal.mockResolvedValue({ id: 11, gtin13: '0022222222223', status: 'pending' });
        const proposal = { gtin13: '0022222222223', localUserId: 7, partNumber: 'HB-1', conversionFactor: 4 };
        expect(await submissions.proposeItemReference(proposal)).toEqual({ id: 11 });
        expect(createItemReferenceProposal).toHaveBeenCalledWith({ ...proposal, orgId: 'treehouse', orgName: 'Treehouse' });
    });

    it('passes a conflict report through', async () => {
        reportConflict.mockResolvedValue({ id: 5 });
        const conflict = { itemReferenceId: 1, existingGtin13: 'A', proposedGtin13: 'B', receiptId: '9', lineItemId: 2 };
        expect(await submissions.reportConflict(conflict)).toEqual({ id: 5 });
        expect(reportConflict).toHaveBeenCalledWith(conflict);
    });

    it('returns the allocated provisional GTIN', async () => {
        allocateNextProvisionalGtin.mockResolvedValue({ gtin13: '2000000000015' });
        expect(await submissions.allocateProvisionalGtin()).toBe('2000000000015');
    });

    it('stamps the org on a provisional-item proposal', async () => {
        createProvisionalItem.mockResolvedValue({ id: 3 });
        const proposal = { provisionalGtin13: '2000000000015', proposedName: 'Bolt', proposedUsageBehavior: 'Durable', localUserId: 7 };
        expect(await submissions.proposeProvisionalItem(proposal)).toBeUndefined();
        expect(createProvisionalItem).toHaveBeenCalledWith({ ...proposal, orgId: 'treehouse', orgName: 'Treehouse' });
    });

    it('rejects a payload outside the contract before calling the catalog', async () => {
        const stray = { gtin13: 'G', localUserId: 7, orgId: 'elsewhere' };
        await expect(submissions.proposeItemReference(stray)).rejects.toThrow();
        expect(createItemReferenceProposal).not.toHaveBeenCalled();
    });

    it('lets a catalog error propagate', async () => {
        reportConflict.mockRejectedValue(new Error('GTIN not found: B'));
        await expect(
            submissions.reportConflict({ itemReferenceId: 1, existingGtin13: 'A', proposedGtin13: 'B', receiptId: '9', lineItemId: 2 }),
        ).rejects.toThrow('GTIN not found: B');
    });
});
