/**
 * Non-Prisma response models the budget-owner routes ship through handler()
 * (the catalogSyntheticClassifications.ts pattern).
 *
 * QuickBooksClassOption — one QuickBooks Class offered to finance for a
 * bucket's mapping (GET /api/budget-owners/quickbooks-classes): its QuickBooks
 * id, its full name ("Parent:Child") and whether it is active. Finance
 * structure, so every field is `internal`.
 *
 * BudgetOwnerApprover — one approver of a bucket (GET /api/budget-owners/[id]/approvers
 * and the Board's owner and treasurer writes): the bucket, the person, their
 * name and their role (OWNER or TREASURER). A name and person id are `public`,
 * as on Person; which bucket they approve is `internal`.
 *
 * BudgetOwnerApproverOption — one person the Board may name owner or
 * treasurer (GET /api/budget-owners/approver-options): id and name, both
 * `public` as on Person.
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
  BudgetOwnerApprover: {
    budgetOwnerId: "internal",
    personId: "public",
    name: "public",
    role: "internal",
  },
  BudgetOwnerApproverOption: {
    id: "public",
    name: "public",
  },
} as const;

export const relations = {} as const;
