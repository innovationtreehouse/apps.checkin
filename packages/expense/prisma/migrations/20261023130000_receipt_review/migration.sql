-- Finance's approval of the receipt behind an expense, as the receipt sent it.
BEGIN;

CREATE TABLE "expense_receipt_reviews" (
    "expense_id" TEXT NOT NULL,
    "reasons" TEXT[],
    "approved_by_user_id" INTEGER NOT NULL,
    "note" TEXT,
    "approved_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "expense_receipt_reviews_pkey" PRIMARY KEY ("expense_id")
);

ALTER TABLE "expense_receipt_reviews" ADD CONSTRAINT "expense_receipt_reviews_expense_id_fkey" FOREIGN KEY ("expense_id") REFERENCES "expenses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
