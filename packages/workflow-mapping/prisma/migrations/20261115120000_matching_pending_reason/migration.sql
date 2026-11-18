BEGIN;
-- Why matching couldn't run: catalog_unavailable, catalog_settings or unexpected_error.
ALTER TABLE "received_receipts" ADD COLUMN "matching_pending_reason" TEXT;
COMMIT;
