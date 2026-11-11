BEGIN;

-- Where each file's bytes live once they move to the private bucket, and their size for the daily limits.
ALTER TABLE "receipts" ADD COLUMN "file_key" TEXT;
ALTER TABLE "receipts" ADD COLUMN "file_size" INTEGER;
ALTER TABLE "receipts" ALTER COLUMN "file_blob" DROP NOT NULL;
ALTER TABLE "receipt_mail_items" ADD COLUMN "file_key" TEXT;
ALTER TABLE "receipt_mail_items" ADD COLUMN "file_size" INTEGER;

COMMIT;
