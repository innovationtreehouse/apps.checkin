-- Every match exclusion names its QuickBooks entity type, since ids are unique per type only.
-- Untyped rows exist only on dev, whose data may be discarded; prod has none.
BEGIN;

DELETE FROM "qb_match_exclusion" WHERE "qb_txn_entity" IS NULL;
ALTER TABLE "qb_match_exclusion" ALTER COLUMN "qb_txn_entity" SET NOT NULL;

COMMIT;
