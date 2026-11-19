BEGIN;

ALTER TABLE "in_kind_donations" DROP COLUMN "withdrawn_after_money_at", DROP COLUMN "withdrawal_settled_at";

COMMIT;
