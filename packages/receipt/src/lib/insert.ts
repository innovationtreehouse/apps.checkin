import { randomUUID } from "node:crypto";
import { db } from "../db";
import type { Prisma } from "../generated/prisma/client";
import { audit, type Actor } from "../repositories/receipt";
import { ServiceError } from "@checkin/component-kit";
import type { ReceiptLimits } from "./limits";
import { deleteStoredFiles, receiptFileKey, sha256Hex } from "./fileStorage";
import { fileStore, storesNewFilesInBucket } from "../runtime";

/** The 429 for the org-wide daily upload limit, which refuses every uploader alike. */
export class OrgUploadLimitError extends ServiceError {
  constructor() {
    super(429, "Receipt uploads have reached today's limit. Try again tomorrow.");
    this.name = "OrgUploadLimitError";
  }
}

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
    "id" | "orgId" | "uploadedByUserId" | "fileBlob" | "fileKey" | "fileSize" | "fileHash" | "mimeType" | "details" | "lineItems" | "auditLogs"
  >;
  detail: Omit<Prisma.ReceiptDetailUncheckedCreateWithoutReceiptInput, "orgId" | "duplicateSuspectReceiptId">;
  lines: NewLine[];
  auditAction: string;
  /** Enforce the daily upload limits for this insert (every upload; the FINANCE import has its own caps). */
  limits?: ReceiptLimits;
  /** A mailed receipt: the per-person count is of the person's own mailed receipts only, against this limit. */
  mailLimit?: number;
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
  // Refuses before storing anything in the common case; the check inside the transaction is the one that holds.
  if (r.limits && storesNewFilesInBucket()) await checkUploadLimits(db, r.orgId, r.actor.id, r.file.length, r.limits, r.mailLimit);
  const [fileKey] = await putFiles([id], [r]);
  await removingFilesOnFailure([fileKey], () => db.$transaction((tx) => insertInto(tx, id, fileKey, r)));
  return id;
}

/** Insert several receipts in one transaction: every one of them, or none if any insert fails. */
export async function insertReceiptsTogether(rs: NewReceipt[], timeoutMs: number): Promise<string[]> {
  const ids = rs.map(() => randomUUID());
  const keys = await putFiles(ids, rs);
  await removingFilesOnFailure(keys, () =>
    db.$transaction(
      async (tx) => {
        for (const [i, r] of rs.entries()) await insertInto(tx, ids[i], keys[i], r);
      },
      { timeout: timeoutMs },
    ),
  );
  return ids;
}

/** Stores each file before its row exists, under its key, or nulls with the flag off. A failed put takes back the ones before it. */
async function putFiles(ids: string[], rs: NewReceipt[]): Promise<(string | null)[]> {
  if (!storesNewFilesInBucket()) return rs.map(() => null);
  const keys: string[] = [];
  await removingFilesOnFailure(keys, async () => {
    for (const [i, r] of rs.entries()) {
      const key = receiptFileKey(ids[i]);
      await fileStore().put(key, r.file, sha256Hex(r.file));
      keys.push(key);
    }
  });
  return keys;
}

async function removingFilesOnFailure<T>(keys: (string | null)[], work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    await deleteStoredFiles(keys);
    throw err;
  }
}

async function insertInto(tx: Prisma.TransactionClient, id: string, fileKey: string | null, r: NewReceipt): Promise<void> {
  const fileHash = sha256Hex(r.file);
  if (r.limits) await enforceUploadLimits(tx, r.orgId, r.actor.id, r.file.length, r.limits, r.mailLimit);
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
      fileBlob: fileKey ? null : new Uint8Array(r.file),
      fileKey,
      fileSize: r.file.length,
      fileHash,
      mimeType: r.mimeType,
      details: { create: { ...r.detail, orgId: r.orgId, duplicateSuspectReceiptId: suspect?.id ?? null } },
      lineItems: { create: toLineRows(r.lines) },
    },
  });
  await audit(tx, id, r.actor, { action: r.auditAction });
  await r.afterInsert?.(tx, id);
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
  mailLimit?: number,
): Promise<void> {
  await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtextextended(${`${orgId}:upload-limits`}, 0))`;
  await checkUploadLimits(tx, orgId, personId, bytes, limits, mailLimit);
}

/** Rows from before file_size was recorded count their bytes in file_blob. */
async function checkUploadLimits(
  client: Prisma.TransactionClient | typeof db,
  orgId: string,
  personId: number,
  bytes: number,
  limits: ReceiptLimits,
  mailLimit?: number,
): Promise<void> {
  const mailed = mailLimit !== undefined;
  const [used] = await client.$queryRaw<{ mineCount: number; mineBytes: number; allBytes: number }[]>`
    SELECT count(*) FILTER (
             WHERE uploaded_by_user_id = ${personId}
               AND (NOT ${mailed} OR (intake_source = 'email' AND NOT EXISTS (
                 SELECT 1 FROM receipt_audit_log a WHERE a.receipt_id = receipts.id AND a.action = 'mail_assigned'))))::int AS "mineCount",
           coalesce(sum(coalesce(file_size, octet_length(file_blob))) FILTER (WHERE uploaded_by_user_id = ${personId}), 0)::float8 AS "mineBytes",
           coalesce(sum(coalesce(file_size, octet_length(file_blob))), 0)::float8 AS "allBytes"
    FROM receipts
    WHERE org_id = ${orgId} AND uploaded_at > now() - interval '24 hours'`;
  if (used.mineCount + 1 > (mailLimit ?? limits.uploadsPerPersonPerDay)) {
    throw new ServiceError(429, "You have reached today's receipt upload limit. Try again tomorrow.");
  }
  if (used.mineBytes + bytes > limits.uploadBytesPerPersonPerDay) {
    throw new ServiceError(429, "You have reached today's upload size limit. Try again tomorrow.");
  }
  if (used.allBytes + bytes > limits.uploadBytesPerDay) {
    throw new OrgUploadLimitError();
  }
}
