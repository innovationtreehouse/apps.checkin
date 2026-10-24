-- The receipt's tax when finance decided, so an approval covers that amount only.
BEGIN;

ALTER TABLE "receipt_finance_reviews" ADD COLUMN "tax_cents" INTEGER;

COMMIT;
