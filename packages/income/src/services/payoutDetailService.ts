import { db } from "../db";
import { createPayoutDetailRepository } from "../repositories/payout-detail";
import { importPayoutDetails } from "../lib/payout-detail-import";
import type { ShopifyPayoutDetailRow } from "../lib/shopify-payout-detail-schemas";

const repo = createPayoutDetailRepository(db);

export const payoutDetailService = {
  async listImportFiles(orgId: string) {
    return repo.listImportFiles(orgId);
  },

  async listUnmatched(orgId: string) {
    const [payoutsWithoutDetail, detailsWithoutPayout] = await Promise.all([
      repo.listPayoutsWithoutDetail(orgId),
      repo.listDetailBlobsWithoutPayout(orgId),
    ]);
    return { payoutsWithoutDetail, detailsWithoutPayout };
  },

  async importPayoutDetails(
    orgId: string,
    rowsByPayoutId: Map<string, ShopifyPayoutDetailRow[]>,
    opts: { userId: number; username?: string; filename: string; buffer: Buffer; correlationId: string },
  ) {
    return importPayoutDetails(orgId, rowsByPayoutId, opts);
  },
};
