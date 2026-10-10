-- Carry the conversion factor through the receive queue and record quantity
-- provenance (raw qty / factor / derived units) on the inventory audit log.
-- The live org_items row continues to store only the running total.

ALTER TABLE "receive_queue" ADD COLUMN "conversion_factor" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "receive_queue" ADD COLUMN "conversion_version" INTEGER NOT NULL DEFAULT 1;

ALTER TABLE "inventory_log" ADD COLUMN "raw_quantity" INTEGER;
ALTER TABLE "inventory_log" ADD COLUMN "conversion_factor" INTEGER;
ALTER TABLE "inventory_log" ADD COLUMN "conversion_version" INTEGER;
