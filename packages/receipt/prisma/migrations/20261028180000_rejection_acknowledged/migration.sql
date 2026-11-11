-- When the uploader acknowledged finance's rejection of their receipt.
BEGIN;

ALTER TABLE "receipt_details" ADD COLUMN "rejection_acknowledged_at" TIMESTAMP(3);

COMMIT;
