BEGIN;

-- AlterTable
ALTER TABLE "in_kind_postings" ADD COLUMN "qb_first_failed_at" TIMESTAMP(3);
ALTER TABLE "in_kind_postings" ADD COLUMN "qb_last_error" TEXT;

-- A gift whose last post failed is timed from its first failed settle since its last settle without
-- a failure (else its last change), and carries its note as its latest error.
WITH gifts AS (
  SELECT p."id", p."org_id",
    CASE p."source" WHEN 'manual' THEN 'manual_in_kind' ELSE 'in_kind' END AS "entity_type",
    CASE p."source" WHEN 'manual' THEN p."gift_id"::text ELSE d."receipt_id" END AS "entity_id"
  FROM "in_kind_postings" p
  LEFT JOIN "in_kind_donations" d ON p."source" = 'receipt' AND d."id" = p."gift_id"
  WHERE p."qb_failure_kind" IS NOT NULL
), settles AS (
  SELECT g."id", e."occurred_at", COALESCE(e."payload" LIKE '%"failure":%', false) AS "failed"
  FROM gifts g
  JOIN "workflow_events" e ON e."org_id" = g."org_id" AND e."entity_type" = g."entity_type" AND e."entity_id" = g."entity_id"
  WHERE e."event_type" = 'IN_KIND_QB_SETTLED'
)
UPDATE "in_kind_postings" p SET
  "qb_first_failed_at" = COALESCE(
    (SELECT MIN(s."occurred_at") FROM settles s WHERE s."id" = p."id" AND s."failed"
       AND s."occurred_at" > COALESCE((SELECT MAX(c."occurred_at") FROM settles c WHERE c."id" = p."id" AND NOT c."failed"), '-infinity'::timestamp)),
    p."updated_at"),
  "qb_last_error" = p."qb_note"
WHERE p."qb_failure_kind" IS NOT NULL;

COMMIT;
