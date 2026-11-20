-- An asset names its source line and unit, so a repeated mint finds the same rows; the sequence
-- holds each org's highest issued asset number.
BEGIN;

ALTER TABLE "capital_assets" ADD COLUMN "source_kind" TEXT,
ADD COLUMN "source_gift_source" TEXT,
ADD COLUMN "source_gift_id" INTEGER,
ADD COLUMN "source_gift_line_id" INTEGER,
ADD COLUMN "unit_index" INTEGER;

CREATE UNIQUE INDEX "capital_assets_org_expense_line_unit_key" ON "capital_assets"("org_id", "source_line_item_id", "unit_index");
CREATE UNIQUE INDEX "capital_assets_org_gift_line_unit_key" ON "capital_assets"("org_id", "source_gift_source", "source_gift_line_id", "unit_index");

CREATE TABLE "capital_asset_sequences" (
    "org_id" TEXT NOT NULL,
    "highest_issued" INTEGER NOT NULL,

    CONSTRAINT "capital_asset_sequences_pkey" PRIMARY KEY ("org_id")
);

COMMIT;
