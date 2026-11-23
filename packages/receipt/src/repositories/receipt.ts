import type { ReceiptState } from "@checkin/receipt-types";
import type { Prisma, Receipt, ReceiptDetail } from "../generated/prisma/client";
import { db, type Db } from "../db";
import { liveIds, withLivePeople } from "../lib/livePeople";

type Tx = Db | Prisma.TransactionClient;

export class ReceiptStateConflictError extends Error {
  constructor(expected: string, actual: string | undefined) {
    super(`Receipt state conflict: expected '${expected}', found '${actual ?? "not_found"}'. Refresh and retry.`);
    this.name = "ReceiptStateConflictError";
  }
}

/**
 * A receipt and its details, flattened, without the file or its failure record (read on its own, for its own page),
 * and without `ocrQueuedAt`, which only the drain's own query orders by.
 */
type OmittedColumns = "fileBlob" | "fileKey" | "fileSize" | "donorSyncSeq" | "firstFailedAt" | "lastError";
export type ReceiptRow = Omit<Receipt, OmittedColumns> & Omit<ReceiptDetail, "id" | "orgId" | "ocrQueuedAt"> & { state: ReceiptState };

const listShape = {
  omit: { fileBlob: true, fileKey: true, fileSize: true, donorSyncSeq: true, firstFailedAt: true, lastError: true },
  include: { details: true },
} as const;

function flatten(r: Omit<Receipt, OmittedColumns> & { details: ReceiptDetail | null }): ReceiptRow {
  const { details, ...core } = r;
  if (!details) throw new Error(`receipt ${r.id} has no details row`);
  const { id: _id, orgId: _orgId, ocrQueuedAt: _queuedAt, ...rest } = details;
  return { ...core, ...rest, state: rest.state as ReceiptState };
}

export interface ReceiptUpdate {
  core?: Prisma.ReceiptUncheckedUpdateInput;
  detail?: Prisma.ReceiptDetailUncheckedUpdateInput;
}

/** Marks the receipt stuck: keeps its first failure's time, and records this failure's error. */
export async function recordFailure(client: Tx, receiptId: string, err: unknown): Promise<void> {
  const lastError = err instanceof Error ? err.message : String(err);
  await client.$executeRaw`UPDATE "receipts" SET "first_failed_at" = COALESCE("first_failed_at", NOW()), "last_error" = ${lastError} WHERE "id" = ${receiptId}`;
}

/** A step that succeeds leaves the receipt no longer stuck. */
export const CLEARED = { firstFailedAt: null, lastError: null } as const;

/** How long a finalized receipt's own push may take before the undelivered receipt counts as stuck. */
export const PUSH_GRACE_MS = 10 * 60 * 1000;

/**
 * Finalized and not delivered, and either its push failed or it was finalized over PUSH_GRACE_MS
 * ago. The second arm catches a push that never recorded its failure: a crash after finalize, or a
 * failed `recordFailure`.
 */
export function stuckUndelivered(now = new Date()): Prisma.ReceiptWhereInput {
  const graceStart = new Date(now.getTime() - PUSH_GRACE_MS);
  return {
    pushedAt: null,
    details: { state: "receipt_finalized" },
    OR: [{ firstFailedAt: { not: null } }, { auditLogs: { none: { action: "finalized", changedAt: { gt: graceStart } } } }],
  };
}

/** When each matching receipt became stuck: its first failure, else its finalize, else its upload. */
export async function stuckSince(where: Prisma.ReceiptWhereInput): Promise<Map<string, Date>> {
  const rows = await db.receipt.findMany({
    where,
    select: {
      id: true,
      firstFailedAt: true,
      uploadedAt: true,
      auditLogs: { where: { action: "finalized" }, orderBy: { changedAt: "desc" }, take: 1, select: { changedAt: true } },
    },
  });
  return new Map(rows.map((r) => [r.id, r.firstFailedAt ?? r.auditLogs[0]?.changedAt ?? r.uploadedAt]));
}

/** A `.catch` for `recordFailure`: a failure that could not be recorded is logged, and the caller goes on. */
export const logUnrecorded = (receiptId: string) => (err: unknown) =>
  console.error(`[receipt] recording the failure of receipt ${receiptId} failed:`, err);

export const receiptRepo = {
  /** Org-scoped. Like every read here, it answers with the live people, not the stored ids. */
  async find(id: string, orgId: string, tx?: Prisma.TransactionClient): Promise<ReceiptRow | undefined> {
    const r = await (tx ?? db).receipt.findFirst({ where: { id, orgId }, ...listShape });
    return r ? (await withLivePeople([flatten(r)]))[0] : undefined;
  },

  async list(where: Prisma.ReceiptWhereInput): Promise<ReceiptRow[]> {
    const rows = await db.receipt.findMany({ where, ...listShape, orderBy: { uploadedAt: "asc" } });
    return withLivePeople(rows.map(flatten));
  },

  count: (where: Prisma.ReceiptWhereInput) => db.receipt.count({ where }),

  /** Each matching receipt's uploader, reimbursee and state, for counts that apply the conflict rule. */
  async listParties(where: Prisma.ReceiptWhereInput): Promise<Array<Pick<ReceiptRow, "id" | "uploadedByUserId" | "reimburseePersonId" | "state">>> {
    const rows = await db.receipt.findMany({
      where,
      select: { id: true, uploadedByUserId: true, reimburseePersonId: true, details: { select: { state: true } } },
    });
    return withLivePeople(rows.flatMap((r) => (r.details ? [{ id: r.id, uploadedByUserId: r.uploadedByUserId, reimburseePersonId: r.reimburseePersonId, state: r.details.state as ReceiptState }] : [])));
  },

  /**
   * Writes both tables in one transaction, or in the caller's `tx`. The detail write is a
   * compare-and-set on `expectedState`, made first so a lost race writes nothing.
   */
  async update(id: string, set: ReceiptUpdate, expectedState: string, tx?: Prisma.TransactionClient): Promise<void> {
    const write = async (client: Prisma.TransactionClient) => {
      const moved = await client.receiptDetail.updateMany({ where: { id, state: expectedState }, data: { state: expectedState, ...set.detail } });
      if (moved.count === 0) {
        const current = await client.receiptDetail.findUnique({ where: { id }, select: { state: true } });
        throw new ReceiptStateConflictError(expectedState, current?.state);
      }
      if (set.core && Object.keys(set.core).length) await client.receipt.update({ where: { id }, data: set.core });
    };
    await (tx ? write(tx) : db.$transaction(write));
  },

  listLineItems: (receiptId: string) =>
    db.receiptLineItem.findMany({ where: { receiptId }, orderBy: { lineNumber: "asc" } }),

  /** `userId` answers as the live person, so an uploader's old edits still read as theirs. */
  async listAuditLogs(receiptId: string) {
    const rows = await db.receiptAuditLog.findMany({ where: { receiptId }, orderBy: [{ changedAt: "asc" }, { id: "asc" }] });
    const live = await liveIds(rows.flatMap((r) => (r.userId === null ? [] : [r.userId])));
    return rows.map((r) => (r.userId === null ? r : { ...r, userId: live.get(r.userId) ?? r.userId }));
  },
};

export interface Actor {
  id: number;
  name: string | null;
}

export interface AuditEntry {
  action: string;
  fieldChanged?: string | null;
  valueBefore?: string | null;
  valueAfter?: string | null;
  lineItemId?: number | null;
}

/** One audit row. A null actor is a system step. */
export async function audit(tx: Tx, receiptId: string, actor: Actor | null, entry: AuditEntry): Promise<void> {
  await tx.receiptAuditLog.create({
    data: { receiptId, userId: actor?.id ?? null, username: actor?.name ?? null, ...entry },
  });
}
