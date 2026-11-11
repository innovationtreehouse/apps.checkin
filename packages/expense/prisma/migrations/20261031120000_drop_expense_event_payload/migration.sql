BEGIN;

-- AlterTable
ALTER TABLE "expense_events" DROP COLUMN "payload";

COMMIT;
