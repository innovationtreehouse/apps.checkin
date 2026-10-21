BEGIN;

-- AlterTable
ALTER TABLE "expense_line_items" ADD COLUMN "resolved_qb_account" TEXT;

-- Backfill each outboxed line's account from its expense_events payload. A payload that does not
-- parse is skipped with a warning rather than failing the migration; the poster reads the payload
-- for any line left without an account.
DO $$
DECLARE
  ev RECORD;
BEGIN
  FOR ev IN SELECT "expense_id", "payload" FROM "expense_events" LOOP
    BEGIN
      UPDATE "expense_line_items" AS li
      SET "resolved_qb_account" = item->>'account'
      FROM jsonb_array_elements(ev."payload"::jsonb->'items') AS item
      WHERE li."expense_id" = ev."expense_id"
        AND li."id" = (item->>'lineItemId')::int
        AND li."resolved_qb_account" IS NULL;
    EXCEPTION WHEN others THEN
      RAISE WARNING 'expense_events %: payload not readable, resolved_qb_account not backfilled', ev."expense_id";
    END;
  END LOOP;
END $$;

COMMIT;
