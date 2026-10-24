-- Keeps whether the receipt's tax needed finance review and the tax finance approved, so later
-- checks read them from the expense; a review row can now exist without an approval.
BEGIN;

ALTER TABLE "expense_receipt_reviews" ADD COLUMN "tax_review_required" BOOLEAN,
ADD COLUMN "approved_tax_cents" INTEGER,
ALTER COLUMN "approved_by_user_id" DROP NOT NULL,
ALTER COLUMN "approved_at" DROP NOT NULL;

COMMIT;
