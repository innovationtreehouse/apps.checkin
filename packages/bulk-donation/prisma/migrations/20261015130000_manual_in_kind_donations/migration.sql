-- CreateTable
CREATE TABLE "manual_in_kind_donations" (
    "id" SERIAL NOT NULL,
    "org_id" TEXT NOT NULL,
    "donor_first_name" TEXT NOT NULL,
    "donor_last_name" TEXT NOT NULL,
    "donor_company_name" TEXT,
    "donation_date" TEXT NOT NULL,
    "recorded_by_user_id" INTEGER NOT NULL,
    "recorded_by_username" TEXT,
    "recorded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "inventory_loaded_at" TIMESTAMP(3),

    CONSTRAINT "manual_in_kind_donations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "manual_in_kind_donation_lines" (
    "id" SERIAL NOT NULL,
    "donation_id" INTEGER NOT NULL,
    "gtin13" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "value_cents" INTEGER NOT NULL,

    CONSTRAINT "manual_in_kind_donation_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "manual_in_kind_donations_org_id_recorded_at_idx" ON "manual_in_kind_donations"("org_id", "recorded_at");

-- CreateIndex
CREATE INDEX "manual_in_kind_donation_lines_donation_id_idx" ON "manual_in_kind_donation_lines"("donation_id");

-- AddForeignKey
ALTER TABLE "manual_in_kind_donation_lines" ADD CONSTRAINT "manual_in_kind_donation_lines_donation_id_fkey" FOREIGN KEY ("donation_id") REFERENCES "manual_in_kind_donations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
