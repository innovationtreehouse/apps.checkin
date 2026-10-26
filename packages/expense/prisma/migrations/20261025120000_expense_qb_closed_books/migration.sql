-- QuickBooks closed books: the lane's switch-on stamp and each expense's first create attempt.
BEGIN;

ALTER TABLE "org_settings" ADD COLUMN "qb_posting_on_at" TIMESTAMP(3);

ALTER TABLE "expenses" ADD COLUMN "qb_create_attempted_at" TIMESTAMP(3);

COMMIT;
