import type { Db } from "../db";
import type { Actor } from "./workflow-engine";

export interface AuditEntry {
  expenseId: string;
  action: string;
  lineItemId?: number | null;
  fieldChanged?: string | null;
  valueBefore?: string | null;
  valueAfter?: string | null;
  notes?: string | null;
}

export async function writeAudit(db: Db, actor: Actor, entry: AuditEntry): Promise<void> {
  await db.expenseAuditLog.create({
    data: {
      expenseId: entry.expenseId,
      userId: actor.userId,
      username: actor.username ?? null,
      action: entry.action,
      lineItemId: entry.lineItemId ?? null,
      fieldChanged: entry.fieldChanged ?? null,
      valueBefore: entry.valueBefore ?? null,
      valueAfter: entry.valueAfter ?? null,
      notes: entry.notes ?? null,
    },
  });
}
