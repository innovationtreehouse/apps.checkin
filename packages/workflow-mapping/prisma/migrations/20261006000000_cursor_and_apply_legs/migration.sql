-- AlterTable
ALTER TABLE "system_data" DROP COLUMN "expense_app_url",
DROP COLUMN "global_server_url",
DROP COLUMN "local_inventory_url",
DROP COLUMN "poll_interval_minutes",
DROP COLUMN "poll_window_end",
DROP COLUMN "poll_window_start",
ADD COLUMN     "org_event_cursor" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "received_receipts" ADD COLUMN     "donation_applied_at" TIMESTAMP(3),
ADD COLUMN     "expense_applied_at" TIMESTAMP(3),
ADD COLUMN     "inventory_applied_at" TIMESTAMP(3);
