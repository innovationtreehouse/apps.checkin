-- #1624 (data): retire WEB. Writers already stamp TYPED (#1744). Three row
-- classes remain on WEB and this migration disposes of each explicitly:
--
--   1. Roster marks the events route stamped WEB before #1622, where AT3
--      (#1478) left an audit row (2026-08-05 → 2026-08-09): these are event-
--      window assertions, not clocks — moved to LEAD_MARKED, completing the
--      20260818120000 pattern for this route. The audit join matches both the
--      CREATE and EDIT branches (pre-#1622 the shared times object overwrote
--      arrivedVia on EDIT too; post-#1622 CREATE audits say LEAD_MARKED and
--      EDIT audits carry no arrivedVia key, so newData arrivedVia='WEB'
--      selects exactly the pre-#1622 audited marks).
--   2. Roster marks from before AT3 (2026-06-29 → 2026-08-05): no audit row
--      exists and Visit has no createdAt, so they are indistinguishable from
--      class 3 and are KNOWINGLY relabeled TYPED with the rest.
--   3. Typed form clocks and dashboard self check-ins: TYPED.
--
-- Tombstoned rows (deletedAt set) are rewritten too — a restored row reads
-- the same as its live siblings. The snapshot table is the undo hook for all
-- of the above (no down migration can otherwise exist: post-rewrite, legacy
-- rows are byte-identical to post-#1744 rows). Drop it in a later release
-- once the relabel has soaked.
--
-- Idempotent: only rewrites WEB; re-running finds nothing. Wrapped because
-- the snapshot and both column moves must commit together (Prisma does not
-- wrap migrations in a transaction on Postgres). WEB stays on the Postgres
-- enum so a rolling-deploy old task that still writes it does not 500.

BEGIN;

-- The snapshot lives in its own schema so the drift check (public schema vs
-- schema.prisma) never sees it.
CREATE SCHEMA IF NOT EXISTS "backfill";
CREATE TABLE IF NOT EXISTS "backfill"."_visit_source_web_backfill" AS
SELECT "id", "arrivedVia", "departedVia"
FROM "Visit"
WHERE "arrivedVia" = 'WEB' OR "departedVia" = 'WEB';

UPDATE "Visit"
SET "arrivedVia" = CASE WHEN "arrivedVia" = 'WEB' THEN 'LEAD_MARKED' ELSE "arrivedVia" END::"VisitSource",
    "departedVia" = CASE WHEN "departedVia" = 'WEB' THEN 'LEAD_MARKED' ELSE "departedVia" END::"VisitSource"
WHERE "id" IN (
    SELECT "affectedEntityId"
    FROM "AuditLog"
    WHERE "tableName" = 'Visit'
      AND "newData"->>'type' = 'lead_attendance_correction'
      AND "newData"->>'arrivedVia' = 'WEB'
)
AND ("arrivedVia" = 'WEB' OR "departedVia" = 'WEB');

UPDATE "Visit"
SET "arrivedVia" = 'TYPED'
WHERE "arrivedVia" = 'WEB';

UPDATE "Visit"
SET "departedVia" = 'TYPED'
WHERE "departedVia" = 'WEB';

COMMIT;
