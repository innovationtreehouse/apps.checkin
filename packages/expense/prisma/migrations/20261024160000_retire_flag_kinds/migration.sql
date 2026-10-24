-- Data only. Three flag kinds stay as finance reviews; the queue reads every other kind from the
-- expense. An open "needs voiding" QB_POST_FAILED row becomes QB_DUPLICATE_TO_VOID, and every
-- other open row of a retired kind is checked off by the system user. Idempotent, so it can run
-- again to catch rows that old code raised during the deploy's drain window.
BEGIN;

UPDATE "expense_flags" f
SET "kind" = 'QB_DUPLICATE_TO_VOID', "audience" = 'FINANCE'
WHERE f."kind" = 'QB_POST_FAILED'
  AND f."checked_off_at" IS NULL
  AND f."detail" LIKE '%needs voiding%'
  AND NOT EXISTS (
    SELECT 1 FROM "expense_flags" d WHERE d."expense_id" = f."expense_id" AND d."kind" = 'QB_DUPLICATE_TO_VOID'
  );

UPDATE "expense_flags"
SET "checked_off_at" = now(),
    "checked_off_by_user_id" = 0,
    "checked_off_by_username" = 'system',
    "notes" = 'retired: the queue now reads this from the expense'
WHERE "checked_off_at" IS NULL
  AND "kind" NOT IN ('QB_DUPLICATE_TO_VOID', 'QB_DRIFT', 'QB_POST_HELD');

COMMIT;
