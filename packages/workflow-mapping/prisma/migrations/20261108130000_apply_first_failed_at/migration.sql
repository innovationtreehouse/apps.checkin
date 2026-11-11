BEGIN;

-- When a receipt's push first failed.
ALTER TABLE "received_receipts" ADD COLUMN "apply_first_failed_at" TIMESTAMP(3);

-- A receipt in apply_failed is timed from its first recorded push failure, else its last change.
UPDATE "received_receipts" r SET "apply_first_failed_at" = COALESCE(
  (SELECT MIN(a."created_at") FROM "workflow_audit_log" a
   WHERE a."received_receipt_id" = r."id" AND a."event_type" = 'receipt_apply_failed'),
  r."updated_at")
WHERE r."state" = 'apply_failed';

COMMIT;
