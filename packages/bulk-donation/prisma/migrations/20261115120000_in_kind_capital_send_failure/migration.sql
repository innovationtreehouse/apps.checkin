BEGIN;

-- AlterTable
ALTER TABLE "in_kind_donations" ADD COLUMN "capital_first_failed_at" TIMESTAMP(3);
ALTER TABLE "in_kind_donations" ADD COLUMN "capital_last_error" TEXT;

-- AlterTable
ALTER TABLE "manual_in_kind_donations" ADD COLUMN "capital_first_failed_at" TIMESTAMP(3);
ALTER TABLE "manual_in_kind_donations" ADD COLUMN "capital_last_error" TEXT;

COMMIT;
