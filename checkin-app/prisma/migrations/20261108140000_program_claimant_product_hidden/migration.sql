BEGIN;

-- AlterTable
ALTER TABLE "Program" ADD COLUMN "claimantProductHiddenAt" TIMESTAMP(3);

COMMIT;
