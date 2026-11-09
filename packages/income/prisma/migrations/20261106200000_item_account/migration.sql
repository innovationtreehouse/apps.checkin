-- Each income item names the QuickBooks account its sales book to.
BEGIN;

ALTER TABLE "income_item_categories" ADD COLUMN "qb_account_id" TEXT;

COMMIT;
