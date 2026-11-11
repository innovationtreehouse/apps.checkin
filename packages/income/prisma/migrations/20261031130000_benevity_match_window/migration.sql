BEGIN;

-- AlterTable
ALTER TABLE "org_settings" ADD COLUMN "benevity_match_window_days" INTEGER NOT NULL DEFAULT 7;

COMMIT;
