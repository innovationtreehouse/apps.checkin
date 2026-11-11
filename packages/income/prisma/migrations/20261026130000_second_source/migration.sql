-- Income's second source (QB_ENTRY_OWNERSHIP PR 1). Additive: every existing row is a Shopify payout.
BEGIN;

-- AlterTable
ALTER TABLE "payout_reconciliations" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'shopify',
ADD COLUMN "expected" JSONB;

-- AlterTable
ALTER TABLE "org_settings" ADD COLUMN "benevity_max_create_cents_per_run" INTEGER NOT NULL DEFAULT 2500000;

COMMIT;
