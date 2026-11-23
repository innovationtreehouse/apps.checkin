-- When a mail item last became held; the 90-day auto-discard counts from it.
BEGIN;

ALTER TABLE "receipt_mail_items" ADD COLUMN "held_at" TIMESTAMP(3);

-- Items already held count from when their row was written.
UPDATE "receipt_mail_items" SET "held_at" = "created_at" WHERE "status" = 'held';

COMMIT;
