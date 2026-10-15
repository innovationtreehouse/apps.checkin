-- Per-program claim on the Shopify product sync (api/programs/[id]/sync-shopify).
-- Expand-only: two nullable columns (metadata-only, no rewrite, no backfill).
-- Old code neither writes nor reads them.
ALTER TABLE "Program" ADD COLUMN "shopifySyncStartedAt" TIMESTAMP(3),
ADD COLUMN "shopifySyncToken" TEXT;
