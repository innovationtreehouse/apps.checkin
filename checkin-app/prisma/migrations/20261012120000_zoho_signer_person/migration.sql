-- Expand-only: one nullable column and its FK. The previous release never names
-- this column in a SELECT, so its reads are unaffected through the drain window.
-- Wrapped so the column and the constraint land together (Prisma does not
-- transact a migration file on Postgres).
BEGIN;

ALTER TABLE "OrgMembershipProcess" ADD COLUMN "zohoSignerPersonId" INTEGER;

ALTER TABLE "OrgMembershipProcess" ADD CONSTRAINT "OrgMembershipProcess_zohoSignerPersonId_fkey" FOREIGN KEY ("zohoSignerPersonId") REFERENCES "Person"("id") ON DELETE SET NULL ON UPDATE CASCADE;

COMMIT;
