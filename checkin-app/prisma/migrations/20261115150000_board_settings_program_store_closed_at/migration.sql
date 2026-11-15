BEGIN;

-- AlterTable
ALTER TABLE "BoardSettings" ADD COLUMN "programStoreClosedAt" TIMESTAMP(3);

COMMIT;
