/**
 * Non-Prisma response models the budget-owner routes ship through handler()
 * (the catalogSyntheticClassifications.ts pattern).
 *
 * QuickBooksClassOption — one QuickBooks Class offered to finance for a
 * bucket's mapping (GET /api/budget-owners/quickbooks-classes): its QuickBooks
 * id, its full name ("Parent:Child") and whether it is active. Finance
 * structure, so every field is `internal`.
 *
 * Hand-authored, not generated: this describes an API response, not a table.
 * This is a security-boundary artifact — changes ship in a boundary PR.
 */
export const classifications = {
  QuickBooksClassOption: {
    id: "internal",
    name: "internal",
    active: "internal",
  },
} as const;

export const relations = {} as const;
