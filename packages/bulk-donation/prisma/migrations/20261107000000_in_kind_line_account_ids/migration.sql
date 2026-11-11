-- A gift-of-goods line can carry the QuickBooks account finance set on it by hand.
BEGIN;

ALTER TABLE "in_kind_donation_lines" ADD COLUMN "quick_books_account_id" TEXT;
ALTER TABLE "manual_in_kind_donation_lines" ADD COLUMN "quick_books_account_id" TEXT;

COMMIT;
