/**
 * Non-Prisma response models the programs routes ship through handler()
 * (the catalogSyntheticClassifications.ts pattern).
 *
 * EligibleCandidate — one row of the eligible-participants staff search
 * (GET /api/programs/[id]/eligible-participants). Names only, by owner ruling
 * (docs/rules/programs.md): id and name, plus `ageWarning`, the program's
 * age-bound label ("Too young", "Too old", "DOB missing", "Adult") or null.
 * The label is computed server-side so no date of birth leaves.
 *
 * UnconfirmedStockRow / UnconfirmedStockSettlement — the board's unconfirmed
 * Shopify stock screen (GET /api/finance-ops/shopify-stock and its settle POST):
 * a program's parked stock change, its owed carry, when it went unconfirmed and
 * Shopify's current `available`. Board bookkeeping, so every field is `internal`.
 *
 * Hand-authored, not generated: this describes an API response, not a table.
 * This is a security-boundary artifact — changes ship in a boundary PR.
 */
export const classifications = {
  EligibleCandidate: {
    id: "public",
    name: "public",
    ageWarning: "public",
  },
  UnconfirmedStockRow: {
    programId: "internal",
    programName: "internal",
    unconfirmed: "internal",
    carry: "internal",
    unconfirmedSince: "internal",
    shopifyAvailable: "internal",
  },
  UnconfirmedStockSettlement: {
    programId: "internal",
    choice: "internal",
    amount: "internal",
    carry: "internal",
  },
} as const;

export const relations = {} as const;
