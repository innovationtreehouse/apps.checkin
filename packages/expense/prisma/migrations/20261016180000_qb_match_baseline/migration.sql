BEGIN;

-- AlterTable
ALTER TABLE "expenses" ADD COLUMN "qb_match_baseline" TEXT;

COMMIT;
