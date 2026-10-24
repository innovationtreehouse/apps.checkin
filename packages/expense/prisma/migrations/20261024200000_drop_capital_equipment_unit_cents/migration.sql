-- Drops the capital-equipment unit threshold, which no code reads or writes.
BEGIN;

ALTER TABLE "org_settings" DROP COLUMN "capital_equipment_unit_cents";

COMMIT;
