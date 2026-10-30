-- The marker the move of donation's QuickBooks holdings into income sets (QB_ENTRY_OWNERSHIP PR 2). Additive and nullable.
BEGIN;

-- AlterTable
ALTER TABLE "donation_org_settings" ADD COLUMN "deposits_handed_over_at" TIMESTAMP(3);

COMMIT;
