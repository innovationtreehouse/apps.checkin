BEGIN;
-- Each parked (unconfirmed) Shopify stock write is kept as its own entry, so
-- writes of opposite sign no longer cancel in one counter. Nullable add: the
-- previous release ignores the column during the deploy drain.
ALTER TABLE "Program" ADD COLUMN "shopifyStockParked" TEXT;
COMMIT;
