export type ItemReferenceProposalEvent =
  | { type: "APPROVE" }
  | { type: "REJECT" }
  | { type: "SUPERSEDE" };
export type ItemReferenceProposalEventType = ItemReferenceProposalEvent["type"];
