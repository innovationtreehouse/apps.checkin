BEGIN;

-- AlterTable
ALTER TABLE "in_kind_donations" ADD COLUMN "capital_submitted_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "manual_in_kind_donations" ADD COLUMN "capital_submitted_at" TIMESTAMP(3);

COMMIT;
