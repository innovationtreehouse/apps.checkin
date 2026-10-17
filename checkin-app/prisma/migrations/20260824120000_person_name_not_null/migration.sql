BEGIN;

-- #1432 R3. R2 (v1.2.0) closed every blank-name write path and backfilled
-- existing rows; this migration proves that held before constraining.
-- Fails loud (nothing altered) if any NULL or blank name survives — fix the
-- rows and rerun rather than letting the ALTER 23502 mid-flight.
DO $$
DECLARE bad integer;
BEGIN
  SELECT COUNT(*) INTO bad FROM "Person" WHERE "name" IS NULL OR btrim("name") = '';
  IF bad > 0 THEN
    RAISE EXCEPTION 'person_name_not_null: % Person rows still have NULL/blank name — R2 backfill incomplete', bad;
  END IF;
END $$;

ALTER TABLE "Person" ALTER COLUMN "name" SET NOT NULL;
ALTER TABLE "Person" ADD CONSTRAINT "Person_name_not_blank" CHECK (btrim("name") <> '');

COMMIT;
