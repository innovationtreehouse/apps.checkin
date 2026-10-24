-- Data only. Runs 20261024160000_retire_flag_kinds again, one release later, for the rows old code
-- raised under a retired kind during that deploy's drain window. Same idempotent statements.
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
    "checked_off_by_user_id" = NULL,
    "checked_off_by_username" = NULL,
    "notes" = 'Closed by the finance-queue migration: retired flag kind; see #2481'
WHERE "checked_off_at" IS NULL
  AND "kind" NOT IN ('QB_DUPLICATE_TO_VOID', 'QB_DRIFT', 'QB_POST_HELD');

COMMIT;
