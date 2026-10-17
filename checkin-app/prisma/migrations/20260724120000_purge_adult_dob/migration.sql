-- #1165: delete DoB for all adults (26+).
--
-- No age-gated program can target anyone over 25 (MAX_PROGRAM_AGE in
-- lib/programAge.ts), so an exact date of birth for a 26+ person is dead weight on
-- Person.dateOfBirth — our most-sensitive (@sensitivity:personal) field. Strip it
-- and set isDeclaredAdult so age gates, the people picker and the household UI
-- still classify them as an adult (all already honor the flag).
--
-- Data-only backfill: no schema change. This is a deliberate, one-time deletion of
-- live data (the whole point of the issue), NOT an accidental data-loss migration.
-- Tombstoned (merged) rows are included — privacy applies to dead records too.
-- The nightly cron re-runs the same statement for anyone who crosses 26 afterward.
UPDATE "Person"
SET "dateOfBirth" = NULL,
    "isDeclaredAdult" = true
WHERE "dateOfBirth" IS NOT NULL
  AND "dateOfBirth" <= (CURRENT_DATE - INTERVAL '26 years');
