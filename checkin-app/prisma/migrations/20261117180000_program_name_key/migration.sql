BEGIN;

-- Nullable until a later release: code still serving the deploy drain inserts programs without it.
ALTER TABLE "Program" ADD COLUMN "nameKey" TEXT;

UPDATE "Program" SET "name" = btrim("name"), "nameKey" = lower(btrim("name"));

-- Fails if two programs in one membership year share a name ignoring case and outer spaces;
-- rename one in the app and redeploy.
CREATE UNIQUE INDEX "Program_nameKey_appliesToYear_key" ON "Program"("nameKey", "appliesToYear");

COMMIT;
