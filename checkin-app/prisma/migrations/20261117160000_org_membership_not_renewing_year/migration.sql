BEGIN;

-- AlterTable
ALTER TABLE "OrgMembership" ADD COLUMN "notRenewingYear" INTEGER;

COMMIT;
