BEGIN;

-- AlterTable
ALTER TABLE "disbursement_events" ADD COLUMN     "qb_create_attempted_at" TIMESTAMP(3),
ADD COLUMN     "qb_note" TEXT;

-- CreateTable
CREATE TABLE "donation_org_settings" (
    "org_id" TEXT NOT NULL,
    "qb_posting_on_at" TIMESTAMP(3),

    CONSTRAINT "donation_org_settings_pkey" PRIMARY KEY ("org_id")
);

COMMIT;
