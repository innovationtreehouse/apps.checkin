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

export interface OrgAuditEntry {
  entityType: "account_mapping" | "qb_account" | "part_owner" | "capital_asset" | "qb_txn" | "donated_capital_line";
  entityId?: string | number | null;
  action: string;
  before?: unknown;
  after?: unknown;
}

const json = (v: unknown) => (v === undefined || v === null ? null : JSON.stringify(v));

/** One row in the org-level audit log, for FINANCE writes that belong to no single expense. */
export async function writeOrgAudit(db: Db, orgId: string, actor: Actor, entry: OrgAuditEntry): Promise<void> {
  await db.expenseOrgAuditLog.create({
    data: {
      orgId,
      actorUserId: actor.userId,
      actorUsername: actor.username ?? null,
      entityType: entry.entityType,
      entityId: entry.entityId != null ? String(entry.entityId) : null,
      action: entry.action,
      before: json(entry.before),
      after: json(entry.after),
    },
  });
}
