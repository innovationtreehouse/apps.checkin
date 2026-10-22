-- Shopify's current line quantity, next to the original `quantity`. Only the current
-- count reflects an order edit that removed a seat, so checkin can tell an order that
-- now pays for fewer seats than it did at checkout. Nullable + additive: old sync code
-- keeps writing rows without it during the rolling deploy, and readers fall back to
-- `quantity` when it is null. Rows synced before this shipped stay null until a
-- BACKFILL run repopulates them (the persisted bulk JSONL predates the query change,
-- so reingestBulkExports cannot fill this).
BEGIN;

ALTER TABLE "shop_order_line" ADD COLUMN "current_quantity" INTEGER;

COMMIT;
