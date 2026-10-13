export type ProvisionalItemEvent =
  | { type: "APPROVE" }
  | { type: "REJECT" }
  | { type: "MAP_TO_EXISTING" };

export type ProvisionalItemEventType = ProvisionalItemEvent["type"];
