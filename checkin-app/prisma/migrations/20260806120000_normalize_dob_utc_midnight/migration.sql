-- dateOfBirth is a calendar date stored as timestamp(3). Normalizes rows written
-- before #1494 put every writer on UTC midnight.
-- Plain ::date, never (col AT TIME ZONE 'UTC')::date: the column is naive, so
-- AT TIME ZONE reads it as timestamptz and casts in the session TimeZone,
-- shifting every row back a day on any connection west of UTC.
UPDATE "Person"
SET "dateOfBirth" = "dateOfBirth"::date
WHERE "dateOfBirth" IS NOT NULL
  AND "dateOfBirth" <> "dateOfBirth"::date;
