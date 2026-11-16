import type { Db } from "../db";
import type { NewWorkflowAuditEvent } from "../db/schema";
import type { Prisma } from "../generated/prisma/client";

export async function insertAuditEvent(
  db: Db | Prisma.TransactionClient,
  event: NewWorkflowAuditEvent,
): Promise<void> {
  await db.workflowAuditLog.create({ data: event });
}

/** Stored details are JSON, except older plain-text notes such as "catalog not connected", which come back as the string. */
export function parseAuditDetails(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}
