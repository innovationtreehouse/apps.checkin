-- Additive enum value for the per-person adult-child membership agreement (#1224).
-- Safe on live data: no drop, no rename, no backfill. Postgres allows ADD VALUE
-- inside a transaction; the value is not used by this migration.
ALTER TYPE "OrgMembershipProcessKind" ADD VALUE 'PERSON_AGREEMENT';
