import type { Db } from "../db";
import type { NewWorkflowAuditEvent } from "../db/schema";
import type { Prisma } from "../generated/prisma/client";

export async function insertAuditEvent(
  db: Db | Prisma.TransactionClient,
  event: NewWorkflowAuditEvent,
): Promise<void> {
  await db.workflowAuditLog.create({ data: event });
}
