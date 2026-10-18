BEGIN;

-- AlterTable
ALTER TABLE "payout_reconciliations" ADD COLUMN "post_claimed_at" TIMESTAMP(3),
ADD COLUMN "qb_create_attempted_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "org_settings" ADD COLUMN "qb_posting_on_at" TIMESTAMP(3);

COMMIT;
