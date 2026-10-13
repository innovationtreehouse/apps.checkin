-- AlterTable
ALTER TABLE "disbursement_events" ADD COLUMN     "qb_match_state" TEXT NOT NULL DEFAULT 'UNMATCHED',
ADD COLUMN     "qb_txn_id" TEXT;

-- DropTable
DROP TABLE "system_data";

-- CreateTable
CREATE TABLE "qb_match_exclusion" (
    "id" SERIAL NOT NULL,
    "org_id" TEXT NOT NULL,
    "qb_txn_id" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "excluded_by_user_id" INTEGER NOT NULL,
    "excluded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "qb_match_exclusion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "qb_match_exclusion_org_id_qb_txn_id_key" ON "qb_match_exclusion"("org_id", "qb_txn_id");

-- CreateIndex
CREATE INDEX "disbursement_events_org_id_qb_match_state_idx" ON "disbursement_events"("org_id", "qb_match_state");

-- CreateIndex
CREATE UNIQUE INDEX "disbursement_events_org_id_qb_txn_id_key" ON "disbursement_events"("org_id", "qb_txn_id");

