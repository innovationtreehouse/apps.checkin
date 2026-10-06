-- Conversion factors become integers system-wide (inventory units per
-- receipt-line unit; no fractional packs, so quantities never need rounding).
-- Existing DOUBLE PRECISION values (all 1.0 to date) round to the nearest int.

ALTER TABLE "inventory_merge_conflicts" ALTER COLUMN "provisional_conversion_factor" DROP DEFAULT;
ALTER TABLE "inventory_merge_conflicts" ALTER COLUMN "provisional_conversion_factor" TYPE INTEGER USING ROUND("provisional_conversion_factor")::integer;
ALTER TABLE "inventory_merge_conflicts" ALTER COLUMN "provisional_conversion_factor" SET DEFAULT 1;

ALTER TABLE "inventory_merge_conflicts" ALTER COLUMN "existing_conversion_factor" DROP DEFAULT;
ALTER TABLE "inventory_merge_conflicts" ALTER COLUMN "existing_conversion_factor" TYPE INTEGER USING ROUND("existing_conversion_factor")::integer;
ALTER TABLE "inventory_merge_conflicts" ALTER COLUMN "existing_conversion_factor" SET DEFAULT 1;
