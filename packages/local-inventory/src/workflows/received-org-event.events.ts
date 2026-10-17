export type ReceivedOrgEventEvent =
  | { type: "PROCESS_SUCCESS" }
  | { type: "PROCESS_FAIL" };

export type ReceivedOrgEventEventType = ReceivedOrgEventEvent["type"];
