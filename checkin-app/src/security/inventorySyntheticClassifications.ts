/**
 * Non-Prisma response models the inventory library ships through handler()
 * (#1287 §11 track 5; the catalogSyntheticClassifications.ts pattern).
 *
 * The paginated inventory lists each have a `.../count` endpoint returning a
 * scalar total that no Prisma model carries, and handler()'s stripper drops any
 * bag key that isn't a known model. One shared shape serves every inventory
 * count route.
 *
 * `total` is `public`: a row count of a list the caller is already admitted to,
 * exposing no actor attribution or free text. No relations.
 *
 * Hand-authored, not generated: it describes an API response, not a table. This
 * is a security-boundary artifact — changes ship in a boundary PR.
 */
export const classifications = {
  InventoryCount: {
    total: "public",
  },
} as const;

export const relations = {} as const;
