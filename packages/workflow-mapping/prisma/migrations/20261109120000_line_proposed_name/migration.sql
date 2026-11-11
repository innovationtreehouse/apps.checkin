BEGIN;

-- The name a manager proposed for a line's provisional part.
ALTER TABLE "received_receipt_line_statuses" ADD COLUMN "proposed_name" TEXT;

COMMIT;
