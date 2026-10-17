-- Record the conversion factor a provisional's stock was counted under, so the
-- merge path can compare it against the resolved real item's canonical factor
-- (carried on the S5 event) and park a uom_mismatch instead of blind-summing.
ALTER TABLE "provisional_items" ADD COLUMN "conversion_factor" INTEGER NOT NULL DEFAULT 1;
