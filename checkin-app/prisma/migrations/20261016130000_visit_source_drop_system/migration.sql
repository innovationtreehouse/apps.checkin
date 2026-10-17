BEGIN;

-- Contract stage of the VisitSource split: drop the retired SYSTEM value.
-- No deployed code writes it, so the drain window is safe. Any row a previous
-- release wrote after the split backfill is mapped by that backfill's rule
-- first: a SYSTEM/SYSTEM pair is a roster mark, any other SYSTEM departure is
-- an AUTO_CLOSE.
UPDATE "Visit"
SET "departedVia" = CASE WHEN "arrivedVia" = 'SYSTEM' THEN 'LEAD_MARKED' ELSE 'AUTO_CLOSE' END::"VisitSource"
WHERE "departedVia" = 'SYSTEM';

UPDATE "Visit"
SET "arrivedVia" = 'LEAD_MARKED'
WHERE "arrivedVia" = 'SYSTEM';

-- Fail closed: abort rather than guess if anything else still holds SYSTEM.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM "Visit" WHERE "arrivedVia" = 'SYSTEM' OR "departedVia" = 'SYSTEM')
       OR EXISTS (SELECT 1 FROM "PresenceEvent" WHERE "source" = 'SYSTEM')
       OR (to_regclass('"backfill"."_visit_source_web_backfill"') IS NOT NULL
           AND EXISTS (SELECT 1 FROM "backfill"."_visit_source_web_backfill"
                       WHERE "arrivedVia" = 'SYSTEM' OR "departedVia" = 'SYSTEM')) THEN
        RAISE EXCEPTION 'VisitSource SYSTEM is still in use; refusing to drop it';
    END IF;
END $$;

-- Postgres cannot drop an enum value in place: swap the type.
ALTER TYPE "VisitSource" RENAME TO "VisitSource_old";
CREATE TYPE "VisitSource" AS ENUM ('SCANNER', 'WEB', 'TYPED', 'LEAD_MARKED', 'FACILITY_CLOSE', 'AUTO_CLOSE');

ALTER TABLE "Visit"
    ALTER COLUMN "arrivedVia" TYPE "VisitSource" USING "arrivedVia"::text::"VisitSource",
    ALTER COLUMN "departedVia" TYPE "VisitSource" USING "departedVia"::text::"VisitSource";
ALTER TABLE "PresenceEvent"
    ALTER COLUMN "source" TYPE "VisitSource" USING "source"::text::"VisitSource";
-- The WEB-relabel undo snapshot shares the type; keep it restorable.
ALTER TABLE IF EXISTS "backfill"."_visit_source_web_backfill"
    ALTER COLUMN "arrivedVia" TYPE "VisitSource" USING "arrivedVia"::text::"VisitSource",
    ALTER COLUMN "departedVia" TYPE "VisitSource" USING "departedVia"::text::"VisitSource";

DROP TYPE "VisitSource_old";

COMMIT;
