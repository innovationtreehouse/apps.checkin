-- Provenance on the live tables, so readers can tell API-synced rows from operator
-- injects (HAND_LOADED / TEST_LOADED) without joining the raw log. Nullable +
-- additive: old sync code keeps writing rows without it during the rolling deploy.
BEGIN;

ALTER TABLE "shop_order" ADD COLUMN "source" "EventSource";
ALTER TABLE "shop_payout" ADD COLUMN "source" "EventSource";
ALTER TABLE "shop_balance_transaction" ADD COLUMN "source" "EventSource";

-- Stamp existing rows from the newest raw event for their gid: every live row was
-- projected from that log, and the newest event is the one that last wrote it.
UPDATE "shop_order" t SET "source" = e."source"
FROM (SELECT DISTINCT ON ("store_id", "shopify_gid") "store_id", "shopify_gid", "source"
        FROM "shopify_raw_event" WHERE "object_type" = 'ORDER'
       ORDER BY "store_id", "shopify_gid", "id" DESC) e
WHERE e."store_id" = t."store_id" AND e."shopify_gid" = t."shopify_gid";

UPDATE "shop_payout" t SET "source" = e."source"
FROM (SELECT DISTINCT ON ("store_id", "shopify_gid") "store_id", "shopify_gid", "source"
        FROM "shopify_raw_event" WHERE "object_type" = 'PAYOUT'
       ORDER BY "store_id", "shopify_gid", "id" DESC) e
WHERE e."store_id" = t."store_id" AND e."shopify_gid" = t."payout_gid";

UPDATE "shop_balance_transaction" t SET "source" = e."source"
FROM (SELECT DISTINCT ON ("store_id", "shopify_gid") "store_id", "shopify_gid", "source"
        FROM "shopify_raw_event" WHERE "object_type" = 'BALANCE_TXN'
       ORDER BY "store_id", "shopify_gid", "id" DESC) e
WHERE e."store_id" = t."store_id" AND e."shopify_gid" = t."txn_gid";

COMMIT;
