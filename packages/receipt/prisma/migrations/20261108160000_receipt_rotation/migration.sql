-- How a receipt's image displays turned, in clockwise degrees; 0 leaves it as uploaded.
BEGIN;

ALTER TABLE "receipts" ADD COLUMN "rotation" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_rotation_check" CHECK ("rotation" IN (0, 90, 180, 270));

COMMIT;
