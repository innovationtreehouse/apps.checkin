import { db } from "../db";
import { createPayoutRepository } from "../repositories/payout";
import { importPayouts } from "../lib/import";
import type { ShopifyPayoutRow } from "../lib/schemas";

const repo = createPayoutRepository(db);

export const payoutService = {
  async listPayouts(orgId: string, page: number, pageSize: number) {
    const [rows, [{ total }]] = await Promise.all([
      repo.listPayouts(orgId, page, pageSize),
      repo.countPayouts(orgId),
    ]);
    return { payouts: rows, total };
  },

  async getPayout(orgId: string, id: number) {
    const rows = await repo.findPayoutById(orgId, id);
    if (rows.length === 0) return null;
    const payout = rows[0];

    let lineItems: unknown[] = [];
    let detailPayload: string | null = null;

    if (payout.shopifyPayoutId) {
      const [lineItemRows, detailBlobRows] = await Promise.all([
        repo.listLineItemsByPayoutId(orgId, payout.shopifyPayoutId),
        repo.findDetailBlobByPayoutId(orgId, payout.shopifyPayoutId),
      ]);
      lineItems = lineItemRows;
      detailPayload = detailBlobRows[0]?.payload ?? null;
    }

    return { ...payout, lineItems, detailPayload };
  },

  async listImportFiles(orgId: string) {
    return repo.listImportFiles(orgId);
  },

  async importPayouts(
    orgId: string,
    rows: ShopifyPayoutRow[],
    opts: { userId: number; username?: string; filename: string; buffer: Buffer; correlationId: string },
  ) {
    return importPayouts(orgId, rows, opts);
  },
};
