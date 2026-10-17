export type ProceedEvent           = { type: "PROCEED" };
export type PushSucceededEvent     = { type: "PUSH_SUCCEEDED" };
export type PushFailedEvent        = { type: "PUSH_FAILED"; error: string };
export type RetryEvent             = { type: "RETRY" };

export type WorkflowMappingEvent =
  | ProceedEvent
  | PushSucceededEvent
  | PushFailedEvent
  | RetryEvent;

export type WorkflowMappingEventType = WorkflowMappingEvent["type"];
