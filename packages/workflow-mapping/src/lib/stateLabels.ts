/** A received receipt's state in plain words. A plain module, so server code can read it as well as the screens. */
export const STATE_LABEL: Record<string, string> = {
  pending_review: "Needs mapping",
  applying: "Applying",
  apply_failed: "Apply failed",
  resolved: "Resolved",
};
