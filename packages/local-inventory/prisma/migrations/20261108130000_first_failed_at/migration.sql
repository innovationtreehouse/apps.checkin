BEGIN;

-- AlterTable
ALTER TABLE "received_inventory_deltas" ADD COLUMN "first_failed_at" TIMESTAMP(3);
ALTER TABLE "received_org_events" ADD COLUMN "first_failed_at" TIMESTAMP(3);
ALTER TABLE "provisional_items" ADD COLUMN "reconcile_first_failed_at" TIMESTAMP(3);
ALTER TABLE "provisional_items" ADD COLUMN "reconcile_last_error" TEXT;

-- A delta or event failed today is timed from when it arrived.
UPDATE "received_inventory_deltas" SET "first_failed_at" = "received_at" WHERE "status" = 'failed';
UPDATE "received_org_events" SET "first_failed_at" = "received_at" WHERE "status" = 'failed';

COMMIT;
