BEGIN;

-- Why a held mail item was held, shown to finance in the mail queue.
ALTER TABLE "receipt_mail_items" ADD COLUMN "hold_reason" TEXT;

COMMIT;
