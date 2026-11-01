export type {
  ReceivedReceipt,
  ReceivedReceiptLineStatus as ReceivedReceiptLineStatusRow,
  WorkflowAuditLog as WorkflowAuditLogRow,
} from "../generated/prisma/client";

// ── Enum arrays (runtime values used for validation) ──────────────────────────

export const receivedReceiptStateEnum = [
  "pending_review",
  "applying",
  "apply_failed",
  "resolved",
] as const;
export type ReceivedReceiptState = (typeof receivedReceiptStateEnum)[number];

/** Lines are editable only before the receipt is sent to apply; the S5 remap edits only these. */
export const EDITABLE_RECEIPT_STATES: ReceivedReceiptState[] = ["pending_review"];

export const EDITABLE_RECEIPT_WHERE = { state: { in: EDITABLE_RECEIPT_STATES } };

/** The apply-failed queue: receipts that need a person. `applying` is listed apart, as in progress. */
export const APPLY_FAILED_QUEUE_STATES: ReceivedReceiptState[] = ["apply_failed"];

export const receivedReceiptLineStatusEnum = [
  "unrecognized",
  "recognized",
  "provisional",
  "non_inventory",
] as const;
export type ReceivedReceiptLineStatus = (typeof receivedReceiptLineStatusEnum)[number];

export const workflowAuditEventTypeEnum = [
  "receipt_created",
  "receipt_proceeded",
  "receipt_apply_started",
  "receipt_apply_succeeded",
  "receipt_apply_failed",
  "receipt_retry_started",
  "line_associated",
  "line_marked_non_inventory",
  "line_proposed",
  "line_remapped",
  // Nothing writes it now; earlier rows still carry it.
  "line_edited_late",
  "provisional_rejected",
  "org_event_rejected",
  "auto_proceed_triggered",
] as const;
export type WorkflowAuditEventType = (typeof workflowAuditEventTypeEnum)[number];

export const AUDIT_EVENT_LABEL: Record<WorkflowAuditEventType, string> = {
  receipt_created: "Receipt received",
  receipt_proceeded: "Sent to apply",
  receipt_apply_started: "Apply started",
  receipt_apply_succeeded: "Apply succeeded",
  receipt_apply_failed: "Apply failed",
  receipt_retry_started: "Apply retried",
  line_associated: "Line associated with catalog item",
  line_marked_non_inventory: "Line marked non-inventory",
  line_proposed: "New catalog item proposed for line",
  line_remapped: "Line moved to approved catalog item",
  line_edited_late: "Line edited after apply",
  provisional_rejected: "Proposed catalog item rejected",
  org_event_rejected: "Catalog event from another org skipped",
  auto_proceed_triggered: "Sent to apply automatically (every line mapped)",
};

function isAuditEventType(eventType: string): eventType is WorkflowAuditEventType {
  return (workflowAuditEventTypeEnum as readonly string[]).includes(eventType);
}

/** The plain-word label for an audit event, or the raw code for one this library doesn't know. */
export function auditEventLabel(eventType: string): string {
  return isAuditEventType(eventType) ? AUDIT_EVENT_LABEL[eventType] : eventType;
}

export type NewWorkflowAuditEvent = {
  orgId: string;
  actorUserId: number | null;
  actorUsername?: string | null;
  eventType: WorkflowAuditEventType;
  receivedReceiptId?: number | null;
  lineStatusId?: number | null;
  fromState?: string | null;
  toState?: string | null;
  details?: string | null;
};
