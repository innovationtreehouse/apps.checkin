-- A stuck receipt's first failure time and latest error, backfilled from the audit log for receipts stuck now.
BEGIN;

ALTER TABLE "receipts" ADD COLUMN "first_failed_at" TIMESTAMP(3);
ALTER TABLE "receipts" ADD COLUMN "last_error" TEXT;

WITH stuck AS (
  SELECT r.id,
         CASE WHEN d.state = 'flow_error' THEN ARRAY['pipeline_failed']
              ELSE ARRAY['push_failed', 'push_refused', 'push_deferred', 'donor_sync_failed'] END AS actions
  FROM "receipts" r
  JOIN "receipt_details" d ON d.id = r.id
  WHERE d.state = 'flow_error' OR (d.state = 'receipt_finalized' AND r.pushed_at IS NULL)
),
failures AS (
  SELECT s.id,
         MIN(a.changed_at) AS first_at,
         (ARRAY_AGG(a.value_after ORDER BY a.changed_at DESC, a.id DESC))[1] AS last_error
  FROM stuck s
  JOIN "receipt_audit_log" a ON a.receipt_id = s.id AND a.action = ANY (s.actions)
  GROUP BY s.id
)
UPDATE "receipts" r
SET first_failed_at = f.first_at, last_error = f.last_error
FROM failures f
WHERE r.id = f.id;

COMMIT;
