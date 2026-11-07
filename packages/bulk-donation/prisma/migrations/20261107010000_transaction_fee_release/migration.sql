-- Who released a fees-only row, and when, once its fee is booked by hand in QuickBooks.
BEGIN;

ALTER TABLE "transactions"
  ADD COLUMN "fee_released_at" TIMESTAMP(3),
  ADD COLUMN "fee_released_by_user_id" INTEGER,
  ADD COLUMN "fee_released_by_name" TEXT;

COMMIT;
