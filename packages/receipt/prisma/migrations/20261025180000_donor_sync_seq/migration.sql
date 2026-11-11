BEGIN;

-- AlterTable
ALTER TABLE "receipts" ADD COLUMN     "donor_sync_seq" INTEGER NOT NULL DEFAULT 0;

COMMIT;
