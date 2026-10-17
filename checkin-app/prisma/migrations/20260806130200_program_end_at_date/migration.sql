-- Calendar date, so the column becomes `date`. Contrast Event.endAt, a genuine
-- datetime that stays a timestamp. Cast with `col::date`, never
-- `(col AT TIME ZONE 'UTC')::date`: the column is a naive timestamp, so AT TIME
-- ZONE would resolve the cast in the session's TimeZone and shift rows west of
-- UTC back a day.
ALTER TABLE "Program" ALTER COLUMN "endAt" TYPE date USING ("endAt"::date);
