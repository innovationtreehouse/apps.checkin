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
