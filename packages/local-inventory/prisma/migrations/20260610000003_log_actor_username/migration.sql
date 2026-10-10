-- AlterTable
ALTER TABLE "inventory_log" ADD COLUMN "username" TEXT;

-- AlterTable
ALTER TABLE "location_log" ADD COLUMN "username" TEXT;

-- AlterTable
ALTER TABLE "provisional_item_log" ADD COLUMN "performed_by_username" TEXT;
