import type { DbOrTx } from "../db";

export type EntityType =
  | "disbursement"
  | "transaction"
  | "account_map"
  | "uploaded_file"
  | "comment_rule"
  | "in_kind"
  | "manual_in_kind"
  | "donation_org_settings";

export interface WorkflowEventInput {
  orgId: string;
  disbursementId?: string | null;
  entityType: EntityType;
  entityId?: string | number | null;
  eventType: string;
  actorUserId?: number | null;
  actorUsername?: string | null;
  correlationId?: string | null;
  payload?: unknown;
}

export async function recordEvent(handle: DbOrTx, e: WorkflowEventInput): Promise<{ id: number; occurredAt: Date }> {
  return handle.workflowEvent.create({
    select: { id: true, occurredAt: true },
    data: {
      orgId: e.orgId,
      disbursementId: e.disbursementId ?? null,
      entityType: e.entityType,
      entityId: e.entityId != null ? String(e.entityId) : null,
      eventType: e.eventType,
      actorUserId: e.actorUserId ?? null,
      actorUsername: e.actorUsername ?? null,
      correlationId: e.correlationId ?? null,
      payload: e.payload !== undefined ? JSON.stringify(e.payload) : null,
      occurredAt: new Date(),
    },
  });
}
