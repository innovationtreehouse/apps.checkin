-- Hidden "reserved seat" Shopify product per program (docs/rules/programs.md).
-- Expand-only: two nullable columns, no default, no backfill. Old code serving
-- during the drain window neither writes nor reads them.
ALTER TABLE "Program" ADD COLUMN "claimantShopifyProductId" TEXT,
ADD COLUMN "claimantShopifyVariantId" TEXT;
