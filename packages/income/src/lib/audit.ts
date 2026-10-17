import type { Prisma } from "../generated/prisma/client";

export type TxClient = Prisma.TransactionClient;

export interface AuditEntry {
  orgId: string;
  actorUserId: number | null;
  actorUsername?: string | null;
  action: string;
  entityType: string;
  entityId?: string | number | null;
  before?: unknown;
  after?: unknown;
  reason?: string | null;
  correlationId?: string | null;
}

export async function recordAudit(tx: TxClient, entry: AuditEntry): Promise<void> {
  await tx.incomeAuditLog.create({
    data: {
      orgId: entry.orgId,
      actorUserId: entry.actorUserId,
      actorUsername: entry.actorUsername ?? null,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId == null ? null : String(entry.entityId),
      before: entry.before === undefined ? null : JSON.stringify(entry.before),
      after: entry.after === undefined ? null : JSON.stringify(entry.after),
      reason: entry.reason ?? null,
      correlationId: entry.correlationId ?? null,
    },
  });
}
