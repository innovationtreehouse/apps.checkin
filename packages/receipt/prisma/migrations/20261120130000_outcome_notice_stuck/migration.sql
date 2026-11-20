-- AlterTable
ALTER TABLE "receipt_outcome_notices" ADD COLUMN "first_failed_at" TIMESTAMP(3);
ALTER TABLE "receipt_outcome_notices" ADD COLUMN "failure_reason" TEXT;
