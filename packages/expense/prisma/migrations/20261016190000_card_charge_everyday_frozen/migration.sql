BEGIN;

-- AlterTable
ALTER TABLE "expenses" ADD COLUMN "everyday_within_limits" BOOLEAN,
ADD COLUMN "everyday_total_limit_cents" INTEGER,
ADD COLUMN "everyday_item_limit_cents" INTEGER;

COMMIT;
