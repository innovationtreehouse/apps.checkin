export type ProvisionalProposalEvent =
  | { type: "APPROVE" }
  | { type: "REJECT" }
  | { type: "MAP_TO_EXISTING" };
export type ProvisionalProposalEventType = ProvisionalProposalEvent["type"];
