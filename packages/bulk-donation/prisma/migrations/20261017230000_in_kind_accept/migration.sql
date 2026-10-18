BEGIN;

-- AlterTable
ALTER TABLE "in_kind_donations" ADD COLUMN     "uploaded_by_user_id" INTEGER,
ADD COLUMN     "donor_replaced_at" TIMESTAMP(3),
ADD COLUMN     "replay_conflict_at" TIMESTAMP(3),
ADD COLUMN     "withdrawal_settled_at" TIMESTAMP(3),
ADD COLUMN     "decision_outcome" TEXT,
ADD COLUMN     "decided_by_user_id" INTEGER,
ADD COLUMN     "decided_at" TIMESTAMP(3),
ADD COLUMN     "donor_household_attested_at" TIMESTAMP(3),
ADD COLUMN     "budget_owner_id" INTEGER,
ADD COLUMN     "bucket_assigned_by_user_id" INTEGER,
ADD COLUMN     "bucket_assigned_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "manual_in_kind_donations" ADD COLUMN     "decision_outcome" TEXT,
ADD COLUMN     "decided_by_user_id" INTEGER,
ADD COLUMN     "decided_at" TIMESTAMP(3),
ADD COLUMN     "donor_household_attested_at" TIMESTAMP(3),
ADD COLUMN     "budget_owner_id" INTEGER,
ADD COLUMN     "bucket_assigned_by_user_id" INTEGER,
ADD COLUMN     "bucket_assigned_at" TIMESTAMP(3);

-- AlterTable: ops' value becomes a suggestion; finance sets value_cents when accepting.
ALTER TABLE "manual_in_kind_donation_lines" ADD COLUMN     "description" TEXT,
ADD COLUMN     "suggested_value_cents" INTEGER,
ALTER COLUMN "value_cents" DROP NOT NULL;

UPDATE "manual_in_kind_donation_lines" SET "suggested_value_cents" = "value_cents" WHERE "suggested_value_cents" IS NULL;

-- CreateTable
CREATE TABLE "in_kind_donation_lines" (
    "id" SERIAL NOT NULL,
    "donation_id" INTEGER NOT NULL,
    "receipt_line_item_id" INTEGER NOT NULL,
    "line_number" INTEGER NOT NULL,
    "description" TEXT NOT NULL,
    "gtin13" TEXT,
    "quantity" DOUBLE PRECISION NOT NULL,
    "value_cents" INTEGER NOT NULL,

    CONSTRAINT "in_kind_donation_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "in_kind_bookings" (
    "id" SERIAL NOT NULL,
    "org_id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "gift_id" INTEGER NOT NULL,
    "side" TEXT NOT NULL,
    "match_state" TEXT NOT NULL,
    "qb_txn_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "in_kind_bookings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "in_kind_donation_lines_donation_id_receipt_line_item_id_key" ON "in_kind_donation_lines"("donation_id", "receipt_line_item_id");

-- CreateIndex
CREATE UNIQUE INDEX "in_kind_bookings_org_id_source_gift_id_side_key" ON "in_kind_bookings"("org_id", "source", "gift_id", "side");

-- CreateIndex
CREATE UNIQUE INDEX "in_kind_bookings_org_id_qb_txn_id_key" ON "in_kind_bookings"("org_id", "qb_txn_id");

-- AddForeignKey
ALTER TABLE "in_kind_donation_lines" ADD CONSTRAINT "in_kind_donation_lines_donation_id_fkey" FOREIGN KEY ("donation_id") REFERENCES "in_kind_donations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
