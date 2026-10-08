import { createHash, randomUUID } from "node:crypto";
import { db } from "../db";
import type { Prisma } from "../generated/prisma/client";
import { audit, type Actor } from "../repositories/receipt";

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
  });
  return id;
}
