BEGIN;

ALTER TABLE "OrgMembershipProcess" ADD COLUMN "membershipYear" INTEGER;

-- Every paid household row must already carry the year it bought (the order fill sets the rest).
DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM "OrgMembershipProcess"
  WHERE kind IN ('INITIAL', 'RENEWAL') AND "paidAt" IS NOT NULL AND "appliesToYear" IS NULL;
  IF n > 0 THEN
    RAISE EXCEPTION '% paid application(s) have no appliesToYear', n;
  END IF;
END $$;

-- Every open payment-plan request must carry its year. Count only: the request is hardship data.
DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM "OrgMembershipProcess"
  WHERE "isPaymentPlanRequested" AND status = 'PENDING_PAYMENT' AND "paymentPlanYear" IS NULL;
  IF n > 0 THEN
    RAISE EXCEPTION '% open payment-plan request(s) have no paymentPlanYear', n;
  END IF;
END $$;

-- Paid household rows: the year the family bought.
UPDATE "OrgMembershipProcess"
SET "membershipYear" = "appliesToYear"
WHERE kind IN ('INITIAL', 'RENEWAL') AND "paidAt" IS NOT NULL AND "membershipYear" IS NULL
  AND EXISTS (SELECT 1 FROM "BoardSettings" WHERE id = 1 AND "orgMembershipYearBoundary" IS NOT NULL);

-- Unpaid household rows: the live year on the org's calendar day of creation. The year y's
-- renewal window opens at the boundary's month and day in y, moved back two calendar months
-- with JavaScript's day rollover; the live year is y from then until year y+1's window opens.
WITH cfg AS (
  SELECT extract(month FROM b."orgMembershipYearBoundary")::int AS bm,
         extract(day   FROM b."orgMembershipYearBoundary")::int AS bd,
         a.timezone AS tz
  FROM "BoardSettings" b CROSS JOIN "AppSettings" a
  WHERE b.id = 1 AND a.id = 1 AND b."orgMembershipYearBoundary" IS NOT NULL
),
d AS (
  SELECT o.id, cfg.bm, cfg.bd,
         ((o."createdAt" AT TIME ZONE 'UTC') AT TIME ZONE cfg.tz)::date AS day
  FROM "OrgMembershipProcess" o CROSS JOIN cfg
  WHERE o.kind IN ('INITIAL', 'RENEWAL') AND o."paidAt" IS NULL AND o."membershipYear" IS NULL
),
live AS (
  SELECT id,
    CASE WHEN day >= (make_date(extract(year FROM day)::int + 1, bm, 1) - interval '2 months')::date + (bd - 1)
           THEN extract(year FROM day)::int + 1
         WHEN day >= (make_date(extract(year FROM day)::int, bm, 1) - interval '2 months')::date + (bd - 1)
           THEN extract(year FROM day)::int
         ELSE extract(year FROM day)::int - 1 END AS year
  FROM d
)
UPDATE "OrgMembershipProcess" o
SET "membershipYear" = live.year
FROM live
WHERE o.id = live.id;

-- Existing agreements, by the owner's fixed cutoff: signed on or after July 15, 2026 on the
-- org's calendar day is 2026-2027, signed earlier is 2025-2026; still open is 2026-2027;
-- closed unsigned is 2025-2026.
UPDATE "OrgMembershipProcess" o
SET "membershipYear" = CASE WHEN (((o."contractSignedAt" AT TIME ZONE 'UTC') AT TIME ZONE a.timezone)::date) < DATE '2026-07-15' THEN 2025 ELSE 2026 END
FROM "AppSettings" a
WHERE a.id = 1 AND o.kind = 'PERSON_AGREEMENT' AND o."membershipYear" IS NULL AND o."contractSignedAt" IS NOT NULL;

UPDATE "OrgMembershipProcess"
SET "membershipYear" = 2026
WHERE kind = 'PERSON_AGREEMENT' AND "membershipYear" IS NULL AND "contractSignedAt" IS NULL
  AND status = 'PENDING_EXTERNAL_ACTION';

UPDATE "OrgMembershipProcess"
SET "membershipYear" = 2025
WHERE kind = 'PERSON_AGREEMENT' AND "membershipYear" IS NULL AND "contractSignedAt" IS NULL
  AND status = 'ARCHIVED';

COMMIT;
