import type { PrismaClient } from "../generated/prisma/client";

export function createPayoutDetailRepository(db: PrismaClient) {
  return {
    async findBlobByPayoutId(orgId: string, shopifyPayoutId: string) {
      const r = await db.shopifyPayoutDetailBlob.findFirst({
        where: { orgId, shopifyPayoutId },
      });
      return r ? [r] : [];
    },

    listLineItemsByPayoutId(orgId: string, shopifyPayoutId: string) {
      return db.shopifyPayoutLineItem.findMany({
        where: { orgId, shopifyPayoutId },
      });
    },

    listImportFiles(orgId: string) {
      return db.payoutDetailImportFile.findMany({
        where: { orgId },
        orderBy: { uploadedAt: "desc" },
      });
    },

    listPayoutsWithoutDetail(orgId: string) {
      return db.payout.findMany({
        where: { orgId, shopifyPayoutId: null },
        select: {
          id: true,
          payoutDate: true,
          status: true,
          totalCents: true,
          currency: true,
          shopifyPayoutId: true,
        },
      });
    },

    async listDetailBlobsWithoutPayout(orgId: string) {
      type RawRow = {
        shopifyPayoutId: string;
        payoutDate: string;
        importedAt: string | number;
        lineCount: bigint;
      };
      const rows = await db.$queryRaw<RawRow[]>`
        SELECT
          sdb.shopify_payout_id as "shopifyPayoutId",
          sdb.payout_date as "payoutDate",
          sdb.imported_at as "importedAt",
          COUNT(spli.id) as "lineCount"
        FROM shopify_payout_detail_blobs sdb
        LEFT JOIN payouts p ON p.org_id = ${orgId} AND p.shopify_payout_id = sdb.shopify_payout_id
        LEFT JOIN shopify_payout_line_items spli ON spli.org_id = ${orgId} AND spli.shopify_payout_id = sdb.shopify_payout_id
        WHERE sdb.org_id = ${orgId} AND p.id IS NULL
        GROUP BY sdb.shopify_payout_id, sdb.payout_date, sdb.imported_at
      `;
      return rows.map((r) => ({
        shopifyPayoutId: r.shopifyPayoutId,
        payoutDate: r.payoutDate,
        importedAt: typeof r.importedAt === "string" ? new Date(r.importedAt) : new Date(Number(r.importedAt)),
        lineCount: Number(r.lineCount),
      }));
    },
  };
}

export type PayoutDetailRepository = ReturnType<typeof createPayoutDetailRepository>;
