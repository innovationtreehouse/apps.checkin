BEGIN;

-- AlterTable
ALTER TABLE "in_kind_postings" ADD COLUMN "qb_post_attempts" INTEGER NOT NULL DEFAULT 0;

COMMIT;
