-- Shopify stock push bookkeeping per program (lib/shopify.ts adjustProgramInventory).
-- Expand-only: two nullable columns and one NOT NULL DEFAULT 0 integer (a
-- metadata-only add on Postgres 11+, no rewrite, no backfill). Old code serving
-- during the drain window neither writes nor reads them.
ALTER TABLE "Program" ADD COLUMN "shopifyStockPushNeededAt" TIMESTAMP(3),
ADD COLUMN "shopifyStockPendingWrite" TEXT,
ADD COLUMN "shopifyStockCarry" INTEGER NOT NULL DEFAULT 0;
