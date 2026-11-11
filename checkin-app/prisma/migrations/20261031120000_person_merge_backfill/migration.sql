-- Gives every merge tombstone a PersonMerge archive row, so a badge carrying a
-- merged-away id still resolves once the tombstone Person row is gone.
--
-- toId is the end of the mergedIntoId chain (the live survivor), walked at most
-- MAX_MERGE_HOPS (5) merges as lib/person/mergeChain.ts does. A chain that never
-- reaches a live row gets no archive row.
--
-- The snapshot matches mergeSnapshot() (lib/person/merge/plan.ts). The merge
-- overwrites the tombstone's email with a sentinel and zeroes its role mirrors,
-- so each field comes from the merge's AuditLog pre-image when one
-- exists (written only for a session actor) and from the tombstone row
-- otherwise. With no pre-image the sentinel email is stored as null, and
-- mergedAt is when this migration ran.
--
-- Data only and idempotent: an existing archive row is never touched.
BEGIN;

-- personMergeBackfill.integration.test.ts runs everything between these markers.
-- >>> BACKFILL START
WITH RECURSIVE walk AS (
  SELECT p.id AS "fromId", p."mergedIntoId" AS cur, 1 AS hops
  FROM "Person" p
  WHERE p."mergedIntoId" IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM "PersonMerge" m WHERE m."fromId" = p.id)
  UNION ALL
  SELECT w."fromId", n."mergedIntoId", w.hops + 1
  FROM walk w
  JOIN "Person" n ON n.id = w.cur
  WHERE n."mergedIntoId" IS NOT NULL AND w.hops < 5
),
survivor AS (
  SELECT w."fromId", w.cur AS "toId"
  FROM walk w
  JOIN "Person" s ON s.id = w.cur AND s."mergedIntoId" IS NULL
),
preimage AS (
  SELECT DISTINCT ON (a."secondaryAffectedEntity")
    a."secondaryAffectedEntity" AS "fromId", a."oldData" AS old, a."timestamp"
  FROM "AuditLog" a
  WHERE a."tableName" = 'Person'
    AND a.action = 'DELETE'
    AND jsonb_typeof(a."oldData") = 'object'
    AND a."oldData" ->> 'id' = a."secondaryAffectedEntity"::text
  ORDER BY a."secondaryAffectedEntity", a."timestamp", a.id
)
INSERT INTO "PersonMerge" ("fromId", "toId", "mergedAt", "snapshot")
SELECT
  p.id,
  s."toId",
  COALESCE(pi."timestamp", now()),
  jsonb_build_object(
    'name', COALESCE(pi.old -> 'name', to_jsonb(p.name)),
    'email', COALESCE(pi.old -> 'email',
      CASE WHEN p.email LIKE 'merged-%@deleted.invalid' THEN 'null'::jsonb ELSE to_jsonb(p.email) END),
    'lastBackgroundCheck', COALESCE(pi.old -> 'lastBackgroundCheck',
      to_jsonb(to_char(p."lastBackgroundCheck", 'YYYY-MM-DD"T"00:00:00.000"Z"'))),
    'isSysadmin', COALESCE(pi.old -> 'isSysadmin', to_jsonb(p."isSysadmin")),
    'isBoardMember', COALESCE(pi.old -> 'isBoardMember', to_jsonb(p."isBoardMember")),
    'isKeyholder', COALESCE(pi.old -> 'isKeyholder', to_jsonb(p."isKeyholder")),
    'isBackgroundCheckReviewer', COALESCE(pi.old -> 'isBackgroundCheckReviewer', to_jsonb(p."isBackgroundCheckReviewer"))
  )
FROM survivor s
JOIN "Person" p ON p.id = s."fromId"
LEFT JOIN preimage pi ON pi."fromId" = p.id
ON CONFLICT ("fromId") DO NOTHING;
-- >>> BACKFILL END

COMMIT;
