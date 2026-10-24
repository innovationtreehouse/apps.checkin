-- Per-program Shopify stock lease and unconfirmed-write bucket (lib/shopify.ts adjustProgramInventory).
-- Expand-only: two nullable columns and one NOT NULL DEFAULT 0 integer (metadata-only
-- on Postgres 11+, no rewrite, no backfill). Old code neither writes nor reads them.
ALTER TABLE "Program" ADD COLUMN "shopifyStockLeaseUntil" TIMESTAMP(3),
ADD COLUMN "shopifyStockLeaseToken" TEXT,
ADD COLUMN "shopifyStockUnconfirmed" INTEGER NOT NULL DEFAULT 0;
