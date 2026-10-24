BEGIN;
-- Sweep attempts in a row that left a receipt applying.
ALTER TABLE "received_receipts" ADD COLUMN "apply_sweep_attempts" INTEGER NOT NULL DEFAULT 0;
COMMIT;
