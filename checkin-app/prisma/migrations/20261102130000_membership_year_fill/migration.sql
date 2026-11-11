-- Records the membership year each settled row already reads as having bought:
-- the year whose renewal window, as membershipYearCycleForLabel computes it, holds
-- the row's stageEnteredAt. Only empty rows change, and nothing reads the column
-- yet, so the release serving the drain window is unaffected. With no boundary set
-- nothing changes. Archived and paid BLOCKED rows stay empty.
BEGIN;

-- membershipYearFill.integration.test.ts runs everything between these markers.
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
-- >>> FILL END

COMMIT;
