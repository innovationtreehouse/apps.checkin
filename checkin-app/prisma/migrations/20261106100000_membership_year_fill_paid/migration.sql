-- Records the membership year on every paid joining or renewing row still empty, so a
-- paid row that later becomes ACTIVE or PENDING_BG_CLEARANCE never reads as unsettled.
-- First re-runs the 20261102130000 fill (settled rows, placed by stageEnteredAt); then
-- places every other paid, non-archived row by paidAt, the year the payment stamp
-- writes (liveMembershipYear at payment). Only empty rows change; with no boundary set
-- nothing changes. Archived rows and per-person kinds stay empty.
BEGIN;

-- membershipYearPaidFill.integration.test.ts runs everything between these markers.
-- >>> FILL START
-- The first-of-month plus days form rolls past a short month as monthsBefore does.
UPDATE "OrgMembershipProcess" AS p
SET "appliesToYear" = (
  SELECT max(y)
  FROM generate_series(
    EXTRACT(YEAR FROM p."stageEnteredAt")::int - 1,
    EXTRACT(YEAR FROM p."stageEnteredAt")::int + 1
  ) AS y
  WHERE make_date(y, b.month, 1) - INTERVAL '2 months' + (b.day - 1) * INTERVAL '1 day'
        <= p."stageEnteredAt"
)
FROM (
  SELECT EXTRACT(MONTH FROM "orgMembershipYearBoundary")::int AS month,
         EXTRACT(DAY FROM "orgMembershipYearBoundary")::int AS day
  FROM "BoardSettings"
  WHERE "id" = 1 AND "orgMembershipYearBoundary" IS NOT NULL
) AS b
WHERE p."appliesToYear" IS NULL
  AND p."stageEnteredAt" IS NOT NULL
  AND p."kind" IN ('INITIAL', 'RENEWAL')
  AND (p."status" = 'ACTIVE' OR (p."status" = 'PENDING_BG_CLEARANCE' AND p."paidAt" IS NOT NULL));

-- A payment on BLOCKED leaves stageEnteredAt untouched, and a rejection moves it.
UPDATE "OrgMembershipProcess" AS p
SET "appliesToYear" = (
  SELECT max(y)
  FROM generate_series(
    EXTRACT(YEAR FROM p."paidAt")::int - 1,
    EXTRACT(YEAR FROM p."paidAt")::int + 1
  ) AS y
  WHERE make_date(y, b.month, 1) - INTERVAL '2 months' + (b.day - 1) * INTERVAL '1 day'
        <= p."paidAt"
)
FROM (
  SELECT EXTRACT(MONTH FROM "orgMembershipYearBoundary")::int AS month,
         EXTRACT(DAY FROM "orgMembershipYearBoundary")::int AS day
  FROM "BoardSettings"
  WHERE "id" = 1 AND "orgMembershipYearBoundary" IS NOT NULL
) AS b
WHERE p."appliesToYear" IS NULL
  AND p."paidAt" IS NOT NULL
  AND p."kind" IN ('INITIAL', 'RENEWAL')
  AND p."status" <> 'ARCHIVED';
-- >>> FILL END

COMMIT;
