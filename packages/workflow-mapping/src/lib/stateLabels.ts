/** A received receipt's state in plain words. A plain module, so server code can read it as well as the screens. */
export const STATE_LABEL: Record<string, string> = {
  pending_review: "Needs mapping",
  applying: "Applying",
  apply_failed: "Apply failed",
  resolved: "Resolved",
};

/** The state label, with a resolved receipt's lines still open on the receive queue counted. */
export function stateLabel(state: string, openBackorders: number): string {
  if (state === "resolved" && openBackorders > 0) return `Received, ${openBackorders} on backorder`;
  return STATE_LABEL[state] ?? state;
}
