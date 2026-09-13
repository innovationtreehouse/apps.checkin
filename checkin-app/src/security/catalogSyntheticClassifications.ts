/**
 * Non-Prisma response models the catalog ships through handler() (#1286 §7).
 *
 * A count endpoint (GET /api/catalog/items/count) returns a scalar total that no
 * Prisma model carries, and handler()'s stripper drops any bag key that isn't a
 * known model. Declaring the count's shape here — merged into `classifications`
 * in core.ts alongside the two generated maps — lets the total ride the same
 * audited model-bag regime as every other response instead of bypassing it.
 *
 * `total` is `public`: it is a count of public reference data (how many catalog
 * items match a filter), exposes no actor/PII, and the read is already gated to
 * catalog viewers by the route's admission. No relations, so none are declared
 * (the stripper defaults an absent model to no relations).
 *
 * Kept hand-authored (not generated) on purpose: it describes an API response
 * model, not a database table, so `prisma generate` neither knows nor should own
 * it. This is a security-boundary artifact — changes ship in a boundary PR.
 */
export const classifications = {
  CatalogItemCount: {
    total: "public",
  },
} as const;

export const relations = {} as const;
