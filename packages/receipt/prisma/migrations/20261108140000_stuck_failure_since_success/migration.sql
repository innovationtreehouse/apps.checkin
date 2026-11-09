-- A stuck receipt is timed from its first failure after its last successful step.
BEGIN;

WITH stuck AS (
  SELECT r.id,
         CASE WHEN d.state = 'flow_error' THEN ARRAY['pipeline_failed']
              ELSE ARRAY['push_failed', 'push_refused', 'push_deferred', 'donor_sync_failed'] END AS actions
  FROM "receipts" r
  JOIN "receipt_details" d ON d.id = r.id
  WHERE r.first_failed_at IS NOT NULL
    AND (d.state = 'flow_error' OR (d.state = 'receipt_finalized' AND r.pushed_at IS NULL))
),
last_success AS (
  SELECT s.id, s.actions, COALESCE(MAX(a.id), 0) AS audit_id
  FROM stuck s
  LEFT JOIN "receipt_audit_log" a ON a.receipt_id = s.id AND a.action IN ('pipeline_transition', 'finalized', 'pushed')
  GROUP BY s.id, s.actions
),
first_failure AS (
  SELECT l.id, MIN(a.changed_at) AS first_at
  FROM last_success l
  JOIN "receipt_audit_log" a ON a.receipt_id = l.id AND a.action = ANY (l.actions) AND a.id > l.audit_id
  GROUP BY l.id
)
UPDATE "receipts" r
SET first_failed_at = f.first_at
FROM first_failure f
WHERE r.id = f.id AND r.first_failed_at IS DISTINCT FROM f.first_at;

COMMIT;
