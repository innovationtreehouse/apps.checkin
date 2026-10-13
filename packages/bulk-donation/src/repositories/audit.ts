import type { DbOrTx } from "../db";

export type EntityType =
  | "disbursement"
  | "transaction"
  | "account_map"
  | "uploaded_file"
  | "comment_rule";

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

export async function recordEvent(handle: DbOrTx, e: WorkflowEventInput): Promise<void> {
  await handle.workflowEvent.create({
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

/** Who read donor data, through which route. The payload never carries a donor field. */
export interface DonorReadContext {
  actorUserId: number;
  actorUsername?: string | null;
  correlationId?: string | null;
  route: string;
}

/** Audit one read that returned donor `pii`: ids or the filter used, and the row count. */
export async function recordDonorDataRead(
  handle: DbOrTx,
  orgId: string,
  entityType: EntityType,
  reader: DonorReadContext,
  read: { ids?: number[]; filter?: Record<string, unknown>; count: number },
): Promise<void> {
  await recordEvent(handle, {
    orgId,
    entityType,
    eventType: "DONOR_DATA_READ",
    actorUserId: reader.actorUserId,
    actorUsername: reader.actorUsername,
    correlationId: reader.correlationId,
    payload: { route: reader.route, ...read },
  });
}
