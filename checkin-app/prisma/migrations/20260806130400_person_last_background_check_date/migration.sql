-- Calendar date, so the column becomes `date`. Cast with `col::date`, never
-- `(col AT TIME ZONE 'UTC')::date`: the column is a naive timestamp, so AT TIME
-- ZONE would resolve the cast in the session's TimeZone and shift rows west of
-- UTC back a day, which on a compliance report reads as a check done a day early.
ALTER TABLE "Person" ALTER COLUMN "lastBackgroundCheck" TYPE date USING ("lastBackgroundCheck"::date);
