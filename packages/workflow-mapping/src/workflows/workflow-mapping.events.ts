export type ProceedEvent           = { type: "PROCEED" };
export type PushSucceededEvent     = { type: "PUSH_SUCCEEDED" };
export type PushFailedEvent        = { type: "PUSH_FAILED"; error: string };
export type RetryEvent             = { type: "RETRY" };
export type CloseOutEvent          = { type: "CLOSE_OUT" };

export type WorkflowMappingEvent =
  | ProceedEvent
  | PushSucceededEvent
  | PushFailedEvent
  | RetryEvent
  | CloseOutEvent;

export type WorkflowMappingEventType = WorkflowMappingEvent["type"];
