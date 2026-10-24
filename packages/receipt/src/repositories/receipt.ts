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
export type ReceiptRow = Omit<Receipt, "fileBlob"> & Omit<ReceiptDetail, "id" | "orgId"> & { state: ReceiptState };

const listShape = { omit: { fileBlob: true }, include: { details: true } } as const;

function flatten(r: Omit<Receipt, "fileBlob"> & { details: ReceiptDetail | null }): ReceiptRow {
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
  async find(id: string, orgId: string, uploadedByUserId?: number): Promise<ReceiptRow | undefined> {
    const r = await db.receipt.findFirst({
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

  /** Writes both tables in one transaction; with `expectedState` it is a compare-and-set. */
  async update(id: string, set: ReceiptUpdate, expectedState?: string): Promise<void> {
    await db.$transaction(async (tx) => {
      if (expectedState !== undefined) {
        const current = await tx.receiptDetail.findUnique({ where: { id }, select: { state: true } });
        if (current?.state !== expectedState) throw new ReceiptStateConflictError(expectedState, current?.state);
      }
      if (set.core && Object.keys(set.core).length) await tx.receipt.update({ where: { id }, data: set.core });
      if (set.detail && Object.keys(set.detail).length) await tx.receiptDetail.update({ where: { id }, data: set.detail });
    });
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
