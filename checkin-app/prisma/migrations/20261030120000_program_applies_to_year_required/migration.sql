-- Fills every program without a membership year by the owner's fixed rule, then
-- requires the column. The running release writes a year on every create, so the
-- constraint cannot meet a write from code serving the drain window.
BEGIN;

-- programYearFill.integration.test.ts runs everything between these markers.
-- >>> FILL START
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM "Program"
             WHERE "appliesToYear" IS NULL AND "startAt" >= DATE '2027-09-01') THEN
    RAISE EXCEPTION 'program year fill: a program without a year starts in 2027-2028 or later';
  END IF;
END $$;
UPDATE "Program" SET "appliesToYear" =
  CASE WHEN "endAt" <= DATE '2026-07-31' THEN 2025 ELSE 2026 END
  WHERE "appliesToYear" IS NULL;
ALTER TABLE "Program" ALTER COLUMN "appliesToYear" SET NOT NULL;
-- >>> FILL END

COMMIT;
