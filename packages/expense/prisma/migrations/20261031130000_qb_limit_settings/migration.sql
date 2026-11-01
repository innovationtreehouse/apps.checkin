BEGIN;

-- AlterTable
ALTER TABLE "org_settings" ADD COLUMN "qb_match_window_days" INTEGER NOT NULL DEFAULT 7,
ADD COLUMN "qb_max_creates_per_day" INTEGER NOT NULL DEFAULT 50,
ADD COLUMN "qb_max_creates_per_run" INTEGER NOT NULL DEFAULT 25;

COMMIT;
