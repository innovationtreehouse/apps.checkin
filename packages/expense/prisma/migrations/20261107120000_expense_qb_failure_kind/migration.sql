BEGIN;

-- AlterTable
ALTER TABLE "expenses" ADD COLUMN "qb_failure_kind" TEXT;

COMMIT;
