BEGIN;

-- AlterTable
ALTER TABLE "org_settings" ADD COLUMN "everyday_total_limit_cents" INTEGER NOT NULL DEFAULT 50000,
ADD COLUMN "everyday_item_limit_cents" INTEGER NOT NULL DEFAULT 25000;

-- AlterTable
ALTER TABLE "expenses" ADD COLUMN "single_source" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "finance_not_everyday" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "board_authorization" TEXT,
ADD COLUMN "board_authorized_by_user_id" INTEGER,
ADD COLUMN "board_authorized_by_username" TEXT,
ADD COLUMN "board_authorized_at" TIMESTAMP(3);

COMMIT;
