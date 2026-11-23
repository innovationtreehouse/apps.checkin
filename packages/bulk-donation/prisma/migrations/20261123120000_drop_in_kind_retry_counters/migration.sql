BEGIN;

ALTER TABLE "in_kind_postings" DROP COLUMN "qb_post_attempts",
DROP COLUMN "qb_failure_kind";

COMMIT;
