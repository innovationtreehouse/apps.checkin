-- The kind of an in-kind gift's last failed QuickBooks post.
BEGIN;

ALTER TABLE "in_kind_postings" ADD COLUMN "qb_failure_kind" TEXT;

COMMIT;
