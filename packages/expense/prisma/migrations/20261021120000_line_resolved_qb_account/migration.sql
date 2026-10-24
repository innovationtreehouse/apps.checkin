BEGIN;

-- AlterTable
ALTER TABLE "expense_line_items" ADD COLUMN "resolved_qb_account" TEXT;

-- AlterTable
ALTER TABLE "expense_events" ALTER COLUMN "payload" DROP NOT NULL;

COMMIT;
