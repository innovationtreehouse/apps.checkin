-- Finance's latest decision on a receipt in financial review, one row per receipt.
BEGIN;

CREATE TABLE "receipt_finance_reviews" (
    "receipt_id" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "reasons" TEXT[],
    "decided_by_user_id" INTEGER NOT NULL,
    "note" TEXT,
    "decided_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "receipt_finance_reviews_pkey" PRIMARY KEY ("receipt_id")
);

ALTER TABLE "receipt_finance_reviews" ADD CONSTRAINT "receipt_finance_reviews_receipt_id_fkey" FOREIGN KEY ("receipt_id") REFERENCES "receipts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
