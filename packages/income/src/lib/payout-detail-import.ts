import { db } from "../db";
import crypto from "crypto";
import { recordAudit } from "./audit";
import type { ShopifyPayoutDetailRow } from "./shopify-payout-detail-schemas";

export interface DetailImportSummary {
  inserted: number;
  duplicate: number;
  payoutIds: string[];
  unmatched: string[];
}

export async function importPayoutDetails(
  orgId: string,
  rowsByPayoutId: Map<string, ShopifyPayoutDetailRow[]>,
  meta: { userId: number; username?: string; filename: string; buffer: Buffer; correlationId?: string },
): Promise<DetailImportSummary> {
  return db.$transaction(async (tx) => {
    const summary: DetailImportSummary = { inserted: 0, duplicate: 0, payoutIds: [], unmatched: [] };

    const fileHash = crypto.createHash("sha256").update(meta.buffer).digest("hex");
    const totalRows = Array.from(rowsByPayoutId.values()).reduce((s, lines) => s + lines.length, 0);
    const fileRow = await tx.payoutDetailImportFile.create({
      data: {
        orgId,
        uploadedByUserId: meta.userId,
        originalFilename: meta.filename,
        fileHash,
        rowCount: totalRows,
        insertedCount: 0,
        duplicateCount: 0,
      },
    });
    const importFileId = fileRow.id;

    for (const [shopifyPayoutId, lines] of rowsByPayoutId) {
      const existing = await tx.shopifyPayoutDetailBlob.findFirst({
        where: { orgId, shopifyPayoutId },
      });

      if (existing) {
        summary.duplicate++;
        continue;
      }

      const payoutDate = lines[0].payoutDate;
      const payload = JSON.stringify({ source: "shopify_payment_transactions", lines });

      await tx.shopifyPayoutDetailBlob.create({
        data: { orgId, shopifyPayoutId, payoutDate, payload, importFileId },
      });

      for (const line of lines) {
        let resolvedOrderId: number | null = null;
        if (line.orderRef) {
          // Orders are stored with purchaseId === the raw Shopify "Name" (e.g. "#1001"),
          // and the transactions export's Order column carries the same "#"-prefixed
          // value. Match verbatim — stripping the "#" here matched no stored order, so
          // every line item's shopifyOrderId was silently left null.
          const orderRow = await tx.shopifyOrder.findFirst({
            where: { orgId, purchaseId: line.orderRef },
          });
          if (orderRow) resolvedOrderId = orderRow.id;
        }

        await tx.shopifyPayoutLineItem.create({
          data: {
            orgId,
            shopifyPayoutId,
            transactionDate: line.transactionDate,
            transactionType: line.transactionType,
            orderRef: line.orderRef,
            shopifyOrderId: resolvedOrderId,
            payoutStatus: line.payoutStatus,
            payoutDate: line.payoutDate,
            amountCents: line.amount,
            feeCents: line.fee,
            netCents: line.net,
            currency: line.currency,
          },
        });
      }

      const sumNet = lines.reduce((s, l) => s + l.net, 0);
      const candidates = await tx.payout.findMany({
        where: {
          orgId,
          payoutDate,
          totalCents: sumNet,
          shopifyPayoutId: null,
        },
      });

      if (candidates.length === 1) {
        await tx.payout.update({
          where: { id: candidates[0].id },
          data: { shopifyPayoutId },
        });
        await recordAudit(tx, {
          orgId, actorUserId: meta.userId, actorUsername: meta.username, action: "payout.detail.linked",
          entityType: "payout", entityId: candidates[0].id,
          after: { shopifyPayoutId, sumNet, payoutDate }, correlationId: meta.correlationId,
        });
      } else {
        summary.unmatched.push(shopifyPayoutId);
        await recordAudit(tx, {
          orgId, actorUserId: meta.userId, actorUsername: meta.username, action: "payout.detail.unmatched",
          entityType: "payout_detail", entityId: shopifyPayoutId,
          after: { reason: candidates.length === 0 ? "no_matching_payout" : "ambiguous_match", candidateCount: candidates.length, sumNet, payoutDate },
          correlationId: meta.correlationId,
        });
      }

      summary.inserted++;
      summary.payoutIds.push(shopifyPayoutId);
    }

    await tx.payoutDetailImportFile.update({
      where: { id: importFileId },
      data: { insertedCount: summary.inserted, duplicateCount: summary.duplicate },
    });

    return summary;
  });
}
