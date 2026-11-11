BEGIN;

-- AlterTable
ALTER TABLE "in_kind_bookings" ADD COLUMN "booked_txn_date" TEXT;

COMMIT;
