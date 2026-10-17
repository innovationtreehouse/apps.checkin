BEGIN;

-- Backfill programs missing dates before constraining NOT NULL.
UPDATE "Program" SET "startAt" = CURRENT_DATE WHERE "startAt" IS NULL;
UPDATE "Program" SET "endAt" = '2027-06-30' WHERE "endAt" IS NULL;

-- Make both columns required.
ALTER TABLE "Program" ALTER COLUMN "startAt" SET NOT NULL;
ALTER TABLE "Program" ALTER COLUMN "endAt" SET NOT NULL;

COMMIT;
