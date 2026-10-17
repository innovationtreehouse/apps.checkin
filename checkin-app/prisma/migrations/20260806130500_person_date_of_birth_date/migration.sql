-- Calendar date, so the column becomes `date`, which also collapses the write
-- conventions the import dedup matches on exactly. Cast with `col::date`, never
-- `(col AT TIME ZONE 'UTC')::date`: the column is a naive timestamp, so AT TIME
-- ZONE would resolve the cast in the session's TimeZone and shift rows west of
-- UTC back a day, which on a date of birth is a wrong birthday and a wrong age.
ALTER TABLE "Person" ALTER COLUMN "dateOfBirth" TYPE date USING ("dateOfBirth"::date);
