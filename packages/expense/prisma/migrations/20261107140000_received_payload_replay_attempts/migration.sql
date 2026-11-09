BEGIN;

-- AlterTable
ALTER TABLE "received_expense_payloads" ADD COLUMN "replay_attempts" INTEGER;

-- A stored payload's build failure is "failed", which the daily replay retries.
UPDATE "received_expense_payloads" SET "status" = 'failed' WHERE "status" = 'refused';

COMMIT;
