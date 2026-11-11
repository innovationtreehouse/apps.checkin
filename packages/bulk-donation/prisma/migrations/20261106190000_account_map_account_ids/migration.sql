-- Each account rule names the QuickBooks account its gifts and matches book to.
BEGIN;

ALTER TABLE "account_map"
  ADD COLUMN "donation_account_id" TEXT,
  ADD COLUMN "match_account_id" TEXT;

COMMIT;
