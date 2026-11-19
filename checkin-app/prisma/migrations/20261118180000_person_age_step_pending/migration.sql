BEGIN;

-- AlterTable
ALTER TABLE "Person" ADD COLUMN "ageStepPending" BOOLEAN NOT NULL DEFAULT false;

COMMIT;
