BEGIN;
-- When matching was deferred because the catalog was unreachable.
ALTER TABLE "received_receipts" ADD COLUMN "matching_pending_since" TIMESTAMP(3);
COMMIT;
