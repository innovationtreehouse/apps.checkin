-- memberSince is a calendar date. Cast with `col::date`, never
-- `(col AT TIME ZONE 'UTC')::date`: the column is a naive timestamp, so AT TIME
-- ZONE would resolve the cast in the session's TimeZone and shift rows west of
-- UTC back a day.
--
-- The default is UTC-pinned rather than the CURRENT_TIMESTAMP it was, because a
-- timestamptz cast to date also resolves in the session's TimeZone: the same
-- instant defaults to a different day on a UTC connection than on a Chicago one.
--
-- Postgres will not retype a column whose default has no implicit cast to the
-- new type, so the default is dropped and re-set around the change. Three
-- statements that must land together, and migrate deploy adds no transaction.
BEGIN;

ALTER TABLE "OrgMembership" ALTER COLUMN "memberSince" DROP DEFAULT;
ALTER TABLE "OrgMembership" ALTER COLUMN "memberSince" TYPE date USING ("memberSince"::date);
ALTER TABLE "OrgMembership" ALTER COLUMN "memberSince" SET DEFAULT (now() AT TIME ZONE 'UTC')::date;

COMMIT;
