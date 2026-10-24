-- Who confirmed the receipt as read: the person reimbursed, or a Board member on their behalf,
-- with the Board member's reason.
BEGIN;

ALTER TABLE "receipt_details" ADD COLUMN "reviewed_by_user_id" INTEGER;
ALTER TABLE "receipt_details" ADD COLUMN "reviewed_on_behalf_reason" TEXT;

COMMIT;
