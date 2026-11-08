BEGIN;

-- AlterTable
ALTER TABLE "expenses" ADD COLUMN "qb_first_failed_at" TIMESTAMP(3);
ALTER TABLE "expenses" ADD COLUMN "qb_last_error" TEXT;
ALTER TABLE "received_expense_payloads" ADD COLUMN "first_failed_at" TIMESTAMP(3);
ALTER TABLE "received_org_events" ADD COLUMN "first_failed_at" TIMESTAMP(3);

-- A failed payload or event is timed from when it arrived.
UPDATE "received_expense_payloads" SET "first_failed_at" = "received_at" WHERE "status" = 'failed';
UPDATE "received_org_events" SET "first_failed_at" = "received_at" WHERE "status" = 'failed';

-- An expense whose last post failed is timed from its first failure since finance last retried it,
-- and carries the note of its latest failure.
WITH failures AS (
  SELECT a."expense_id", a."changed_at", a."notes"
  FROM "expense_audit_log" a
  JOIN "expenses" e ON e."id" = a."expense_id"
  WHERE e."qb_failure_kind" IS NOT NULL
    AND a."action" IN ('qb_post_failed', 'qb_needs_finance', 'qb_waiting_on_settings')
    AND a."changed_at" > COALESCE(
      (SELECT MAX(r."changed_at") FROM "expense_audit_log" r WHERE r."expense_id" = a."expense_id" AND r."action" = 'qb_post_retried'),
      '-infinity'::timestamp)
)
UPDATE "expenses" e SET
  "qb_first_failed_at" = COALESCE((SELECT MIN(f."changed_at") FROM failures f WHERE f."expense_id" = e."id"), e."submitted_at"),
  "qb_last_error" = (SELECT f."notes" FROM failures f WHERE f."expense_id" = e."id" ORDER BY f."changed_at" DESC LIMIT 1)
WHERE e."qb_failure_kind" IS NOT NULL;

COMMIT;
