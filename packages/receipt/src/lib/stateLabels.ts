/** A receipt state in plain words. A plain module, so server code can read it as well as the screens. */
export const STATE_LABELS: Record<string, string> = {
  auto_upload: "Reading",
  uploaded: "Processing",
  ocr_failed: "Couldn't read",
  duplicate_flagged: "Possible duplicate",
  validation_failed: "Totals don't add up",
  submitter_review: "Needs your review",
  financial_review: "Finance review",
  flow_error: "Error",
  discarded: "Discarded",
  rejected: "Rejected",
  receipt_finalized: "Done",
};

/** A receipt discarded while its duplicate flag stood open: a flag, once cleared, never returns. */
export function isDiscardedDuplicate(r: { state: string; duplicateFlaggedAt?: string | Date | null; duplicateFlagClearedAt?: string | Date | null }): boolean {
  return r.state === "discarded" && r.duplicateFlaggedAt != null && r.duplicateFlagClearedAt == null;
}

/** A receipt's state in plain words, naming a duplicate discard as one. */
export function receiptStateLabel(r: Parameters<typeof isDiscardedDuplicate>[0]): string {
  return isDiscardedDuplicate(r) ? "Discarded as a duplicate" : (STATE_LABELS[r.state] ?? r.state);
}
