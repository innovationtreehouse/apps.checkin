/**
 * Non-Prisma response models the expense library ships through handler()
 * (the catalogSyntheticClassifications.ts pattern).
 *
 * Counts, the injected bucket list, per-line sign-off status, the capital-seed
 * result and QuickBooks match candidates are not Prisma models, and handler()'s
 * stripper drops any bag key that isn't a known model. Who is reimbursed is `pii`
 * wherever it appears: a candidate's `vendorRef` (on a Bill the vendor is the
 * reimbursee), a QuickBooks Vendor's name, and the reimbursee's id and name.
 * Everything else is `internal`. No shape names a signer.
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
  // Per line: seats filled, missing and blocked (seat names only, no signer).
  ExpenseLineSignoffStatus: {
    lineItemId: "internal",
    filled: "internal",
    missing: "internal",
    blocked: "internal",
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
} as const;

export const relations = {
  ExpenseCapitalSeedResult: {
    results: { model: "ExpenseCapitalSeedRow", isList: true },
  },
} as const;
