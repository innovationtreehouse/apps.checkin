BEGIN;

-- AlterTable
ALTER TABLE "income_item_categories" ALTER COLUMN "budget_owner_id" DROP NOT NULL;

COMMIT;
