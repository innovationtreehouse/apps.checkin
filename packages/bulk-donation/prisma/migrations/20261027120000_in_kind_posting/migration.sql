BEGIN;

-- In-kind posting (#2182 step 4). Additive: no app code writes in_kind_bookings before this release.

ALTER TABLE "donation_org_settings" ADD COLUMN "in_kind_qb_posting_on_at" TIMESTAMP(3);

ALTER TABLE "in_kind_bookings" ADD COLUMN "qb_entity" TEXT;
DROP INDEX "in_kind_bookings_org_id_qb_txn_id_key";
CREATE UNIQUE INDEX "in_kind_bookings_org_id_qb_entity_qb_txn_id_key" ON "in_kind_bookings"("org_id", "qb_entity", "qb_txn_id");

CREATE TABLE "in_kind_postings" (
    "id" SERIAL NOT NULL,
    "org_id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "gift_id" INTEGER NOT NULL,
    "match_state" TEXT NOT NULL,
    "claimed_at" TIMESTAMP(3),
    "qb_create_attempted_at" TIMESTAMP(3),
    "qb_note" TEXT,
    "booked_total_cents" INTEGER,
    "booked_txn_date" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "in_kind_postings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "in_kind_postings_org_id_source_gift_id_key" ON "in_kind_postings"("org_id", "source", "gift_id");
CREATE INDEX "in_kind_postings_org_id_qb_create_attempted_at_idx" ON "in_kind_postings"("org_id", "qb_create_attempted_at");

COMMIT;
