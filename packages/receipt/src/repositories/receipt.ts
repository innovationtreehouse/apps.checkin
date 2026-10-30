import type { ReceiptState } from "@checkin/receipt-types";
import type { Prisma, Receipt, ReceiptDetail } from "../generated/prisma/client";
import { db, type Db } from "../db";

type Tx = Db | Prisma.TransactionClient;

export class ReceiptStateConflictError extends Error {
  constructor(expected: string, actual: string | undefined) {
    super(`Receipt state conflict: expected '${expected}', found '${actual ?? "not_found"}'. Refresh and retry.`);
    this.name = "ReceiptStateConflictError";
  }
}

/** A receipt and its details, flattened, without the file. */
export type ReceiptRow = Omit<Receipt, "fileBlob" | "donorSyncSeq"> & Omit<ReceiptDetail, "id" | "orgId"> & { state: ReceiptState };

const listShape = { omit: { fileBlob: true, donorSyncSeq: true }, include: { details: true } } as const;

function flatten(r: Omit<Receipt, "fileBlob" | "donorSyncSeq"> & { details: ReceiptDetail | null }): ReceiptRow {
  const { details, ...core } = r;
  if (!details) throw new Error(`receipt ${r.id} has no details row`);
  const { id: _id, orgId: _orgId, ...rest } = details;
  return { ...core, ...rest, state: rest.state as ReceiptState };
}

export interface ReceiptUpdate {
  core?: Prisma.ReceiptUncheckedUpdateInput;
  detail?: Prisma.ReceiptDetailUncheckedUpdateInput;
}

export const receiptRepo = {
  /** Org-scoped; `uploadedByUserId` narrows to one submitter's receipts. */
  async find(id: string, orgId: string, uploadedByUserId?: number, tx?: Prisma.TransactionClient): Promise<ReceiptRow | undefined> {
    const r = await (tx ?? db).receipt.findFirst({
      where: { id, orgId, ...(uploadedByUserId === undefined ? {} : { uploadedByUserId }) },
      ...listShape,
    });
    return r ? flatten(r) : undefined;
  },

  async list(where: Prisma.ReceiptWhereInput): Promise<ReceiptRow[]> {
    const rows = await db.receipt.findMany({ where, ...listShape, orderBy: { uploadedAt: "asc" } });
    return rows.map(flatten);
  },

  count: (where: Prisma.ReceiptWhereInput) => db.receipt.count({ where }),

  /** Each matching receipt's uploader, reimbursee and state, for counts that apply the conflict rule. */
  async listParties(where: Prisma.ReceiptWhereInput): Promise<Array<Pick<ReceiptRow, "id" | "uploadedByUserId" | "reimburseePersonId" | "state">>> {
    const rows = await db.receipt.findMany({
      where,
      select: { id: true, uploadedByUserId: true, reimburseePersonId: true, details: { select: { state: true } } },
    });
    return rows.flatMap((r) => (r.details ? [{ id: r.id, uploadedByUserId: r.uploadedByUserId, reimburseePersonId: r.reimburseePersonId, state: r.details.state as ReceiptState }] : []));
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

  listAuditLogs: (receiptId: string) =>
    db.receiptAuditLog.findMany({ where: { receiptId }, orderBy: [{ changedAt: "asc" }, { id: "asc" }] }),
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
