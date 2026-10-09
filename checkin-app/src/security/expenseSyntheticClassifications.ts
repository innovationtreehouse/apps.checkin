/**
 * Non-Prisma response models the expense library ships through handler()
 * (#1272 §5/§7; the catalogSyntheticClassifications.ts pattern).
 *
 * Counts, the injected bucket list, per-line sign-off status, the capital-seed
 * result and QuickBooks match candidates are not Prisma models, and handler()'s
 * stripper drops any bag key that isn't a known model. Everything is `internal`
 * except a candidate's `vendorRef`: on a Bill the vendor is the reimbursee, so it
 * is `pii`.
 *
 * None of these shapes names a signer or the reimbursee by person id; those live
 * only on the Prisma models, as `pii`.
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
} as const;

export const relations = {
  ExpenseCapitalSeedResult: {
    results: { model: "ExpenseCapitalSeedRow", isList: true },
  },
} as const;
