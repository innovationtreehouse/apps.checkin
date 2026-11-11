export const STATE_LABELS: Record<string, string> = {
  assign_ownership: "Assign Ownership",
  resolve_ownership: "Resolve Ownership",
  owner_approval: "Owner Approval",
  owner_exception: "Owner Exception",
  capital_review: "Capital Review",
  set_depreciation_cycle: "Set Depreciation",
  qb_pending: "QB Pending",
  qb_on_hold: "QB On Hold",
  qb_complete: "QB Complete",
  qb_skipped: "QB Skipped (backfill)",
  qb_error: "QB Error",
};

export const STATE_COLORS: Record<string, string> = {
  assign_ownership: "yellow",
  resolve_ownership: "orange",
  owner_approval: "blue",
  owner_exception: "red",
  capital_review: "violet",
  set_depreciation_cycle: "grape",
  qb_pending: "teal",
  qb_on_hold: "orange",
  qb_complete: "green",
  qb_skipped: "gray",
  qb_error: "red",
};

/** The answer when finance searches or links a QuickBooks Vendor while QuickBooks is off. */
export const QB_OFF = "QuickBooks isn't connected here, so Vendors can't be searched or linked";

/** Why the QuickBooks drain is holding an expense back. NEEDS_FINANCE stays general: posts may have failed, or the expense's own data stops it. */
export const NOT_SENT: Record<string, string> = {
  NOT_TEST_DATA: "Not sent to QuickBooks: not test data",
  TEST_DATA_REFUSED: "Not sent to QuickBooks: test data is never posted in prod",
  NEEDS_FINANCE: "Not sent to QuickBooks: it waits for finance to fix what stops it posting",
  AMBIGUOUS: "Not sent to QuickBooks: waiting for finance to pick the matching entry or link the reimbursee's vendor",
  UNBOOKED: "Not sent to QuickBooks: the app does not book it on its own; finance books it or matches it",
  SKIPPED: "Not sent to QuickBooks: finance skipped it",
};
