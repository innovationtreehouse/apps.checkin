-- AlterTable
ALTER TABLE "expense_line_items" ALTER COLUMN "quantity" SET DEFAULT 1,
ALTER COLUMN "quantity" SET DATA TYPE DOUBLE PRECISION;

-- AlterTable
ALTER TABLE "expenses" ADD COLUMN     "backfill" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "capital_assets" (
    "id" SERIAL NOT NULL,
    "org_id" TEXT NOT NULL,
    "asset_number" TEXT NOT NULL,
    "parent_asset_number" TEXT,
    "description" TEXT NOT NULL,
    "acquisition_date" TEXT,
    "cost_cents" INTEGER,
    "depreciation_years" INTEGER,
    "fully_depreciated_date" TEXT,
    "status" TEXT NOT NULL DEFAULT 'tracked',
    "source_expense_id" TEXT,
    "source_line_item_id" INTEGER,
    "source_receipt_id" TEXT,
    "source_qb_txn_id" TEXT,
    "seeded" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "capital_assets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "capital_assets_org_id_asset_number_key" ON "capital_assets"("org_id", "asset_number");

