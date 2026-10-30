-- Benevity's own switch-on stamp (QB_ENTRY_OWNERSHIP PR 2). Additive and nullable: old code never reads it.
BEGIN;

-- AlterTable
ALTER TABLE "org_settings" ADD COLUMN "benevity_qb_posting_on_at" TIMESTAMP(3);

COMMIT;
