BEGIN;

ALTER TABLE "BoardSettings" ADD COLUMN "financeAlertEmailAddress" TEXT,
ADD COLUMN "sysadminEmailAddress" TEXT,
ADD COLUMN "bgReviewerEmailAddress" TEXT;

UPDATE "BoardSettings" SET "financeAlertEmailAddress" = "alertEmailAddress";

COMMIT;
