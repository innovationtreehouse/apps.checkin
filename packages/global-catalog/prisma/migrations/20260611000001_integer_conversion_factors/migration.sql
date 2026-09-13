-- Conversion factors become integers system-wide (inventory units per
-- receipt-line unit; no fractional packs, so quantities never need rounding).
-- Existing DOUBLE PRECISION values (all 1.0 to date) round to the nearest int.

-- item_references.conversion_factor: DOUBLE PRECISION -> INTEGER
ALTER TABLE "item_references" ALTER COLUMN "conversion_factor" DROP DEFAULT;
ALTER TABLE "item_references" ALTER COLUMN "conversion_factor" TYPE INTEGER USING ROUND("conversion_factor")::integer;
ALTER TABLE "item_references" ALTER COLUMN "conversion_factor" SET DEFAULT 1;

-- item_reference_proposals.conversion_factor: DOUBLE PRECISION -> INTEGER
ALTER TABLE "item_reference_proposals" ALTER COLUMN "conversion_factor" DROP DEFAULT;
ALTER TABLE "item_reference_proposals" ALTER COLUMN "conversion_factor" TYPE INTEGER USING ROUND("conversion_factor")::integer;
ALTER TABLE "item_reference_proposals" ALTER COLUMN "conversion_factor" SET DEFAULT 1;

-- conversion_challenges factors: DOUBLE PRECISION -> INTEGER (no defaults)
ALTER TABLE "conversion_challenges" ALTER COLUMN "current_factor" TYPE INTEGER USING ROUND("current_factor")::integer;
ALTER TABLE "conversion_challenges" ALTER COLUMN "proposed_factor" TYPE INTEGER USING ROUND("proposed_factor")::integer;

-- provisional_items: carry the human-entered conversion factor through to approve/map emit.
ALTER TABLE "provisional_items" ADD COLUMN "conversion_factor" INTEGER NOT NULL DEFAULT 1;
