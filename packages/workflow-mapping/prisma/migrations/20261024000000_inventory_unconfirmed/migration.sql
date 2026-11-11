BEGIN;
-- When inventory may have taken a receipt's delta without its stamp.
ALTER TABLE "received_receipts" ADD COLUMN "inventory_unconfirmed_at" TIMESTAMP(3);
COMMIT;
