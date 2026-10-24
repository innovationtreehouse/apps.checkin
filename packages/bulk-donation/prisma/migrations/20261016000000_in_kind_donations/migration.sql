-- CreateTable
CREATE TABLE "in_kind_donations" (
    "id" SERIAL NOT NULL,
    "org_id" TEXT NOT NULL,
    "receipt_id" TEXT NOT NULL,
    "receipt_total_cents" INTEGER,
    "receipt_date" TEXT,
    "money_received_at" TIMESTAMP(3),
    "donor_first_name" TEXT,
    "donor_last_name" TEXT,
    "donor_company_name" TEXT,
    "donor_recorded_at" TIMESTAMP(3),
    "withdrawn_after_money_at" TIMESTAMP(3),

    CONSTRAINT "in_kind_donations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "in_kind_donations_org_id_receipt_id_key" ON "in_kind_donations"("org_id", "receipt_id");
