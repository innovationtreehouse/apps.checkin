import { createHash, randomUUID } from "node:crypto";
import { db } from "../db";
import type { Prisma } from "../generated/prisma/client";
import { audit, type Actor } from "../repositories/receipt";
import { ServiceError } from "../services/serviceError";
import type { ReceiptLimits } from "./limits";

export interface NewLine {
  description: string;
  partNumber?: string | null;
  manufacturer?: string | null;
  quantity: number;
  unitPriceCents: number;
  totalPriceCents?: number;
  isDelayed?: boolean;
  lineNumber?: number;
}

export function toLineRows(lines: NewLine[]): Prisma.ReceiptLineItemCreateWithoutReceiptInput[] {
  return lines.map((li, i) => ({
    lineNumber: li.lineNumber ?? i + 1,
    description: li.description,
    partNumber: li.partNumber?.trim() || null,
    manufacturer: li.manufacturer?.trim() || null,
    quantity: li.quantity,
    unitPriceCents: li.unitPriceCents,
    totalPriceCents: li.totalPriceCents ?? Math.round(li.quantity * li.unitPriceCents),
    isDelayed: li.isDelayed ?? false,
  }));
}

export interface NewReceipt {
  orgId: string;
  actor: Actor;
  file: Buffer;
  mimeType: string;
  core?: Omit<
    Prisma.ReceiptUncheckedCreateInput,
    "id" | "orgId" | "uploadedByUserId" | "fileBlob" | "fileHash" | "mimeType" | "details" | "lineItems" | "auditLogs"
  >;
  detail: Omit<Prisma.ReceiptDetailUncheckedCreateWithoutReceiptInput, "orgId" | "duplicateSuspectReceiptId">;
  lines: NewLine[];
  auditAction: string;
  /** Enforce the daily upload limits for this insert (every upload; the FINANCE import has its own caps). */
  limits?: ReceiptLimits;
  /** Runs inside the insert's transaction, so a failure rolls the receipt back with it. */
  afterInsert?: (tx: Prisma.TransactionClient, id: string) => Promise<unknown>;
}

/**
 * Insert a receipt under a transaction-scoped advisory lock on (org, file hash), recording the
 * earliest existing receipt with the same file as its duplicate suspect. The lock serialises
 * only identical files in one org, so a second concurrent upload always sees the first.
 * The (orgId, fileHash) index stays non-unique: a duplicate inserts and is flagged for a person.
 */
export async function insertReceipt(r: NewReceipt): Promise<string> {
  const id = randomUUID();
  const fileHash = createHash("sha256").update(r.file).digest("hex");
  await db.$transaction(async (tx) => {
    if (r.limits) await enforceUploadLimits(tx, r.orgId, r.actor.id, r.file.length, r.limits);
    await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtextextended(${`${r.orgId}:${fileHash}`}, 0))`;
    const suspect = await tx.receipt.findFirst({
      where: { orgId: r.orgId, fileHash },
      orderBy: [{ uploadedAt: "asc" }, { id: "asc" }],
      select: { id: true },
    });
    await tx.receipt.create({
      data: {
        ...r.core,
        id,
        orgId: r.orgId,
        uploadedByUserId: r.actor.id,
        fileBlob: new Uint8Array(r.file),
        fileHash,
        mimeType: r.mimeType,
        details: { create: { ...r.detail, orgId: r.orgId, duplicateSuspectReceiptId: suspect?.id ?? null } },
        lineItems: { create: toLineRows(r.lines) },
      },
    });
    await audit(tx, id, r.actor, { action: r.auditAction });
    await r.afterInsert?.(tx, id);
  });
  return id;
}

/**
 * Refuses (429) an upload that would pass a daily limit. The org-wide lock serialises uploads
 * so concurrent requests cannot all pass the same check; it is taken before the file-hash lock.
 */
async function enforceUploadLimits(
  tx: Prisma.TransactionClient,
  orgId: string,
  personId: number,
  bytes: number,
  limits: ReceiptLimits,
): Promise<void> {
  await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtextextended(${`${orgId}:upload-limits`}, 0))`;
  const [used] = await tx.$queryRaw<{ mineCount: number; mineBytes: number; allBytes: number }[]>`
    SELECT count(*) FILTER (WHERE uploaded_by_user_id = ${personId})::int AS "mineCount",
           coalesce(sum(octet_length(file_blob)) FILTER (WHERE uploaded_by_user_id = ${personId}), 0)::float8 AS "mineBytes",
           coalesce(sum(octet_length(file_blob)), 0)::float8 AS "allBytes"
    FROM receipts
    WHERE org_id = ${orgId} AND uploaded_at > now() - interval '24 hours'`;
  if (used.mineCount + 1 > limits.uploadsPerPersonPerDay) {
    throw new ServiceError(429, "You have reached today's receipt upload limit. Try again tomorrow.");
  }
  if (used.mineBytes + bytes > limits.uploadBytesPerPersonPerDay) {
    throw new ServiceError(429, "You have reached today's upload size limit. Try again tomorrow.");
  }
  if (used.allBytes + bytes > limits.uploadBytesPerDay) {
    throw new ServiceError(429, "Receipt uploads have reached today's limit. Try again tomorrow.");
  }
}
