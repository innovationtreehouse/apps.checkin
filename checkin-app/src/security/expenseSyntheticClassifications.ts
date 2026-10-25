/**
 * Non-Prisma response models the expense library ships through handler()
 * (the catalogSyntheticClassifications.ts pattern).
 *
 * Counts, the injected bucket list, per-line sign-off status, the capital-seed
 * result and QuickBooks match candidates are not Prisma models, and handler()'s
 * stripper drops any bag key that isn't a known model. Who is reimbursed is `pii`
 * wherever it appears: a candidate's `vendorRef` (on a Bill the vendor is the
 * reimbursee), a QuickBooks Vendor's name, and the reimbursee's id and name.
 * Everything else is `internal`. No shape names a signer, and what a caller may
 * do on a line describes that caller only.
 *
 * Hand-authored, not generated: it describes API responses, not tables. This is a
 * security-boundary artifact — changes ship in a boundary PR.
 */
export const classifications = {
  // GET /api/counts: one count per queue view.
  ExpenseCounts: {
    assign_ownership: "internal",
    resolve_ownership: "internal",
    owner_approval: "internal",
    owner_exception: "internal",
    capital_review: "internal",
    set_depreciation_cycle: "internal",
    qb_pending: "internal",
    expense_holds: "internal",
  },
  // `total` for a list's .../count endpoint (numbered pagination).
  ExpenseListCount: {
    total: "internal",
  },
  // A budget-owner bucket from the injected OwnerDirectory.
  ExpenseBucketView: {
    id: "internal",
    name: "internal",
    archivedAt: "internal",
  },
  // Per line: seats filled, missing and blocked (seat names only, no signer),
  // the acts the caller may take there and the open steps waiting on others.
  // `actions`, `awaiting` and `mayRecordBoardAuthorization` describe the caller
  // only and name no one else.
  ExpenseLineSignoffStatus: {
    lineItemId: "internal",
    filled: "internal",
    missing: "internal",
    blocked: "internal",
    actions: "internal",
    awaiting: "internal",
    mayRecordBoardAuthorization: "internal",
  },
  // POST /api/capital-assets/seed outcome.
  ExpenseCapitalSeedResult: {
    created: "internal",
    skipped: "internal",
    errors: "internal",
  },
  ExpenseCapitalSeedRow: {
    assetNumber: "internal",
    status: "internal",
    error: "internal",
  },
  // A QuickBooks Purchase or Bill offered to finance as a match for a line.
  ExpenseQbCandidateView: {
    id: "internal",
    txnDate: "internal",
    totalCents: "internal",
    accountRef: "internal",
    vendorRef: "pii",
  },
  // A QuickBooks Vendor offered to finance for the reimbursee link; names are often people's.
  ExpenseQbVendorOption: {
    id: "internal",
    displayName: "pii",
  },
  // The reimbursee named on the link screen.
  ExpenseReimburseeView: {
    personId: "pii",
    name: "pii",
  },
  // A donated gift line in capital review: the gift's value and finance's
  // decision. The reviewer's id is `pii`; there is no donor field.
  DonatedCapitalLineView: {
    id: "internal",
    orgId: "internal",
    giftSource: "internal",
    giftId: "internal",
    giftLineId: "internal",
    description: "internal",
    quantity: "internal",
    costCents: "internal",
    acquisitionDate: "internal",
    budgetOwnerId: "internal",
    isCapital: "internal",
    depreciationYears: "internal",
    reviewedByUserId: "pii",
    reviewedAt: "internal",
  },
  // GET /api/expense/finance-queue?tab=…: one record waiting on finance or the Board.
  // The queue's row and counts hold reason codes, money, dates and counts, never a person.
  FinanceQueueRow: {
    expenseId: "internal",
    vendorName: "internal",
    date: "internal",
    amountCents: "internal",
    currency: "internal",
    reasons: "internal",
    waitingSince: "internal",
  },
  // GET /api/expense/finance-queue/counts: per tab, `{ actionable, total, byReason }`.
  FinanceQueueCounts: {
    expenses: "internal",
    toSign: "internal",
    accountHolds: "internal",
    quickbooks: "internal",
    board: "internal",
  },
  // GET /api/expense/expenses/[id]: one open queue reason on the expense, for the
  // viewer. `detail` can carry QuickBooks' last error text, so it is `personal`,
  // matching the flag detail it comes from.
  ExpenseQueueReason: {
    code: "internal",
    tab: "internal",
    actionable: "internal",
    amountCents: "internal",
    count: "internal",
    detail: "personal",
  },
} as const;

export const relations = {
  ExpenseCapitalSeedResult: {
    results: { model: "ExpenseCapitalSeedRow", isList: true },
  },
} as const;
