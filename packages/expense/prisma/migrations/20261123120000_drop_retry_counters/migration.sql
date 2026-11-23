BEGIN;

ALTER TABLE "expenses" DROP COLUMN "qb_post_attempts",
DROP COLUMN "qb_failure_kind";

ALTER TABLE "received_expense_payloads" DROP COLUMN "replay_attempts";

COMMIT;
