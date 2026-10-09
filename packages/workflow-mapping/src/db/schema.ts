export type {
  ReceivedReceipt,
  ReceivedReceiptLineStatus as ReceivedReceiptLineStatusRow,
  WorkflowAuditLog as WorkflowAuditLogRow,
  WorkflowSystemData,
} from "../generated/prisma/client";

// ── Enum arrays (runtime values used for validation) ──────────────────────────

export const receivedReceiptStateEnum = [
  "pending_review",
  "applying",
  "apply_failed",
  "resolved",
] as const;
export type ReceivedReceiptState = (typeof receivedReceiptStateEnum)[number];

/** States whose lines a manager may still edit (and the S5 remap may touch). */
export const EDITABLE_RECEIPT_STATES: ReceivedReceiptState[] = ["pending_review", "apply_failed"];

/** A receipt's lines are editable in an editable state while no downstream leg has applied. */
export const EDITABLE_RECEIPT_WHERE = {
  state: { in: EDITABLE_RECEIPT_STATES },
  inventoryAppliedAt: null,
  expenseAppliedAt: null,
  donationAppliedAt: null,
};

/** The apply-failed queue also lists `applying`, so a receipt whose push never landed is visible. */
export const APPLY_FAILED_QUEUE_STATES: ReceivedReceiptState[] = ["apply_failed", "applying"];

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
  "provisional_rejected",
  "org_event_rejected",
  "auto_proceed_triggered",
] as const;
export type WorkflowAuditEventType = (typeof workflowAuditEventTypeEnum)[number];

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
