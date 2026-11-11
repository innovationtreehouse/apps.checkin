BEGIN;

-- The sender check's outcome on each mail item, shown in the mail queue and read when approving a mail alias.
ALTER TABLE "receipt_mail_items" ADD COLUMN "dmarc_verdict" TEXT;

COMMIT;
