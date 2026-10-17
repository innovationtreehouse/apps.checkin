-- AlterTable
ALTER TABLE "items" ADD COLUMN "created_by_username" TEXT;
ALTER TABLE "items" ADD COLUMN "updated_by_username" TEXT;

-- AlterTable
ALTER TABLE "item_references" ADD COLUMN "created_by_username" TEXT;
ALTER TABLE "item_references" ADD COLUMN "updated_by_username" TEXT;
