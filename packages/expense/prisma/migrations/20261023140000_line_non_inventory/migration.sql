BEGIN;

-- AlterTable
ALTER TABLE "expense_line_items" ADD COLUMN "non_inventory" BOOLEAN NOT NULL DEFAULT false;

COMMIT;
