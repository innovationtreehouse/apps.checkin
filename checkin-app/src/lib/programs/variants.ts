type ProgramVariantFields = {
    shopifyVariantId?: string | null;
    claimantShopifyVariantId?: string | null;
};

/** Every variant whose paid line counts as a seat in this program: the public one and the hidden claimant one. */
export function programVariantIds(p: ProgramVariantFields): string[] {
    return [p.shopifyVariantId, p.claimantShopifyVariantId].filter((v): v is string => !!v);
}

/**
 * The variant the app's checkout link sells. Every app checkout follows a claim,
 * so it is the untracked claimant variant when the program has one; otherwise the
 * public variant.
 */
export function checkoutVariantId(p: ProgramVariantFields): string | null {
    return p.claimantShopifyVariantId || p.shopifyVariantId || null;
}
