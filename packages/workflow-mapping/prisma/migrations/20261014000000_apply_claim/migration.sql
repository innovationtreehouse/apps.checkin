-- Lease a caller holds while it pushes a receipt (one push at a time).
ALTER TABLE "received_receipts" ADD COLUMN "apply_claimed_at" TIMESTAMP(3);
