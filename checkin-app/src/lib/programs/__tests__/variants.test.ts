import { checkoutVariantId, programVariantIds } from '../variants';

describe('program variants', () => {
    it('checkout prefers the claimant variant, else the public one', () => {
        expect(checkoutVariantId({ shopifyVariantId: 'pub', claimantShopifyVariantId: 'claim' })).toBe('claim');
        expect(checkoutVariantId({ shopifyVariantId: 'pub', claimantShopifyVariantId: null })).toBe('pub');
        expect(checkoutVariantId({})).toBeNull();
    });

    it('a paid line on either variant counts for the program', () => {
        expect(programVariantIds({ shopifyVariantId: 'pub', claimantShopifyVariantId: 'claim' })).toEqual(['pub', 'claim']);
        expect(programVariantIds({ shopifyVariantId: 'pub' })).toEqual(['pub']);
        expect(programVariantIds({ shopifyVariantId: null, claimantShopifyVariantId: null })).toEqual([]);
    });
});
