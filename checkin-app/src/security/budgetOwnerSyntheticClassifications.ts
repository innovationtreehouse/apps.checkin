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
 * BooksMapClass — one bucket's row in the books map (GET /api/books-map and
 * PUT /api/books-map/classes/[budgetOwnerId]): the bucket, its name and the
 * QuickBooks Class id it books to. Finance structure, so every field is
 * `internal`.
 *
 * BooksMapAccount — one named role in the books map (GET /api/books-map and
 * PUT /api/books-map/accounts/[role]): the role and the QuickBooks account id
 * it books to. Every field is `internal`.
 *
 * QuickBooksAccountOption — one QuickBooks account offered to finance for a
 * role (GET /api/books-map/quickbooks-accounts): its id, full name, account
 * type and whether it is active. Every field is `internal`.
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
  BooksMapClass: {
    budgetOwnerId: "internal",
    budgetOwnerName: "internal",
    quickBooksClassId: "internal",
  },
  BooksMapAccount: {
    role: "internal",
    quickBooksAccountId: "internal",
  },
  QuickBooksAccountOption: {
    id: "internal",
    name: "internal",
    accountType: "internal",
    active: "internal",
  },
} as const;

export const relations = {} as const;
