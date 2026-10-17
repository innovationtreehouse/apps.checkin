-- Expand-only: three nullable columns and their FK. The previous release serves
-- traffic against this schema for the whole drain window and never names these
-- columns in a SELECT, so its reads are unaffected (rule 1).
-- Wrapped because the columns and the constraint must land together: Prisma does
-- not transact a migration file on Postgres (rule 5).
BEGIN;

ALTER TABLE "OrgMembershipProcess" ADD COLUMN     "intakeNoteSnapshot" TEXT,
ADD COLUMN     "noteAckAt" TIMESTAMP(3),
ADD COLUMN     "noteAckById" INTEGER;

ALTER TABLE "OrgMembershipProcess" ADD CONSTRAINT "OrgMembershipProcess_noteAckById_fkey" FOREIGN KEY ("noteAckById") REFERENCES "Person"("id") ON DELETE SET NULL ON UPDATE CASCADE;

COMMIT;
