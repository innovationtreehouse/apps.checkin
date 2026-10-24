-- Who confirmed the receipt as read: the person reimbursed, or a Board member on their behalf.
BEGIN;

ALTER TABLE "receipt_details" ADD COLUMN "reviewed_by_user_id" INTEGER;

COMMIT;
