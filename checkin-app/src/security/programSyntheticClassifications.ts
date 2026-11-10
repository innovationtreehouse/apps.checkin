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
 * ProgramPaymentPlanDecision / MembershipPaymentPlanDecision — one decided
 * payment-plan request on the Past views (GET /api/finance-ops/payment-plans/past
 * and GET /api/finance-ops/membership-payment-plans/past). The outcome and its
 * date say a request existed, so they carry the request's `hardship` tier; the
 * decider is staff-action metadata, `internal`.
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
  ProgramPaymentPlanDecision: {
    id: "public",
    programId: "public",
    personId: "public",
    personName: "public",
    personEmail: "pii",
    programName: "public",
    outcome: "hardship",
    decidedAt: "hardship",
    decidedById: "internal",
    decidedByName: "internal",
  },
  MembershipPaymentPlanDecision: {
    id: "public",
    processId: "public",
    householdId: "public",
    householdName: "public",
    outcome: "hardship",
    decidedAt: "hardship",
    decidedById: "internal",
    decidedByName: "internal",
  },
} as const;

export const relations = {} as const;

// Finance marks: the fields whose presence in a response makes it a logged finance view.
export const marks = {
  ProgramPaymentPlanDecision: ["outcome", "decidedAt"],
  MembershipPaymentPlanDecision: ["outcome", "decidedAt"],
} as const;
