-- Calendar date, so the column becomes `date` (docs/conventions.md, "A day is
-- not a moment"). Cast with `col::date`, never `(col AT TIME ZONE 'UTC')::date`:
-- the column is a naive timestamp, so AT TIME ZONE would resolve the cast in the
-- session's TimeZone and shift rows west of UTC back a day.
ALTER TABLE "BoardSettings" ALTER COLUMN "orgMembershipYearBoundary" TYPE date USING ("orgMembershipYearBoundary"::date);
