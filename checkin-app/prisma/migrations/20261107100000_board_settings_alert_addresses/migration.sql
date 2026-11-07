BEGIN;

ALTER TABLE "BoardSettings" ADD COLUMN "alertEmailAddress" TEXT,
ADD COLUMN "boardEmailAddress" TEXT;

COMMIT;
