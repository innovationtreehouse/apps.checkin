import { db } from "../db";
import crypto from "crypto";
import type { ShopifyPayoutRow, ShopifyPayoutPayload } from "./schemas";
import { createPayoutFromRow } from "./payout-write";
import { recordAudit } from "./audit";
import { getIncomeConfig, isoDay } from "../runtime";

export type RowResult = "inserted" | "duplicate" | "conflict" | "rejected";

export interface RowOutcome {
  rowIndex: number;
  result: RowResult;
  payoutDate: string;
  totalCents: number;
  /** Why a row was rejected; set only when result is "rejected". */
  reason?: "mirror_period";
}

export interface ImportSummary {
  inserted: number;
  duplicate: number;
  conflict: number;
  rejected: number;
  rows: RowOutcome[];
}

export async function importPayouts(
  orgId: string,
  rows: ShopifyPayoutRow[],
  meta?: { userId: number; username?: string; filename: string; buffer: Buffer; correlationId?: string },
): Promise<ImportSummary> {
  const { mirrorFrom } = getIncomeConfig();
  const mirrorDay = mirrorFrom ? isoDay(mirrorFrom) : null;

  return db.$transaction(async (tx) => {
    const summary: ImportSummary = { inserted: 0, duplicate: 0, conflict: 0, rejected: 0, rows: [] };

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      // The mirror owns every payout from its first day on; a CSV copy would double it.
      if (mirrorDay && row.payoutDate >= mirrorDay) {
        summary.rejected++;
        summary.rows.push({ rowIndex: i, result: "rejected", reason: "mirror_period", payoutDate: row.payoutDate, totalCents: row.totalCents });
        continue;
      }
      const payload: ShopifyPayoutPayload = { ...row, source: "shopify" };
      const payloadJson = JSON.stringify(payload);

      const existing = await tx.payout.findFirst({
        where: { orgId, payoutDate: row.payoutDate, totalCents: row.totalCents },
      });

      const existingImport = existing
        ? await tx.payoutImport.findUnique({ where: { id: existing.id } })
        : null;

      if (!existing || !existingImport) {
        const importId = await createPayoutFromRow(tx, orgId, row, payloadJson);
        if (meta) {
          await recordAudit(tx, {
            orgId, actorUserId: meta.userId, actorUsername: meta.username, action: "payout.import.inserted",
            entityType: "payout", entityId: importId, after: payload, correlationId: meta.correlationId,
          });
        }
        summary.inserted++;
        summary.rows.push({ rowIndex: i, result: "inserted", payoutDate: row.payoutDate, totalCents: row.totalCents});
        continue;
      }

      if (existingImport.payload === payloadJson) {
        summary.duplicate++;
        summary.rows.push({ rowIndex: i, result: "duplicate", payoutDate: row.payoutDate, totalCents: row.totalCents});
        continue;
      }

      await tx.payoutConflict.create({
        data: {
          orgId,
          incomingPayload: payloadJson,
          existingImportId: existingImport.id,
          reason: "payload_mismatch",
          status: "pending",
        },
      });
      if (meta) {
        await recordAudit(tx, {
          orgId, actorUserId: meta.userId, actorUsername: meta.username, action: "payout.import.conflict",
          entityType: "payout", entityId: existingImport.id,
          before: JSON.parse(existingImport.payload), after: payload, correlationId: meta.correlationId,
        });
      }
      summary.conflict++;
      summary.rows.push({ rowIndex: i, result: "conflict", payoutDate: row.payoutDate, totalCents: row.totalCents});
    }

    if (meta) {
      const fileHash = crypto.createHash("sha256").update(meta.buffer).digest("hex");
      await tx.payoutImportFile.create({
        data: {
          orgId,
          uploadedByUserId: meta.userId,
          originalFilename: meta.filename,
          fileHash,
          rowCount: rows.length,
          insertedCount: summary.inserted,
          duplicateCount: summary.duplicate,
          conflictCount: summary.conflict,
        },
      });
    }

    return summary;
  });
}
