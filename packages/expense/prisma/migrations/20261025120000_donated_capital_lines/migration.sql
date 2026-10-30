BEGIN;

-- AlterTable
ALTER TABLE "capital_assets" ADD COLUMN "source_donated_line_id" INTEGER;

-- CreateTable
CREATE TABLE "donated_capital_lines" (
    "id" SERIAL NOT NULL,
    "org_id" TEXT NOT NULL,
    "gift_source" TEXT NOT NULL,
    "gift_id" INTEGER NOT NULL,
    "gift_line_id" INTEGER NOT NULL,
    "description" TEXT NOT NULL,
    "quantity" DOUBLE PRECISION NOT NULL,
    "cost_cents" INTEGER NOT NULL,
    "acquisition_date" TEXT,
    "budget_owner_id" INTEGER NOT NULL,
    "is_capital" BOOLEAN,
    "depreciation_years" INTEGER,
    "reviewed_by_user_id" INTEGER,
    "reviewed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "donated_capital_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "donated_capital_lines_gift_line_key" ON "donated_capital_lines"("org_id", "gift_source", "gift_id", "gift_line_id");

COMMIT;
