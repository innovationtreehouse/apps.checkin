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
 * QuickBooksListsStatus — the saved copy of one QuickBooks list, accounts or
 * Classes (GET /api/books-map/quickbooks-lists and POST
 * /api/books-map/quickbooks-lists/refresh): which list, when it was last
 * refreshed and how many entries it holds. Every field is `internal`.
 *
 * QuickBooksPostingCatchUp — the QuickBooks posting slot as finance's catch-up
 * reads it (GET and POST /api/finance/quickbooks/catch-up): the lane asked for,
 * its `status` (POST: started or queued; GET: running, queued, stranded or
 * idle), the lane holding the slot (`heldBy`) and until when (`until`), and the
 * lanes waiting (`queued`), when a QuickBooks throttle pause ends
 * (`pausedUntil`, null when none is in force), and each lane's last run
 * (`lastRuns`, keyed by lane: when and how it ended, entries created and
 * matched, the cap that stopped it, throttle yields in a row). Lane names,
 * times and counts only, every field `internal`.
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
  QuickBooksListsStatus: {
    list: "internal",
    refreshedAt: "internal",
    entries: "internal", // a count, not the list
  },
  QuickBooksPostingCatchUp: {
    lane: "internal",
    status: "internal",
    heldBy: "internal",
    until: "internal",
    queued: "internal",
    pausedUntil: "internal",
    lastRuns: "internal",
  },
} as const;

export const relations = {} as const;

// Finance marks: the fields whose presence in a response makes it a logged finance view.
export const marks = {} as const;
