BEGIN;

-- AlterTable
ALTER TABLE "disbursement_events" ADD COLUMN     "qb_deposit_total_cents" INTEGER,
ADD COLUMN     "qb_deposit_txn_date" TEXT,
ADD COLUMN     "qb_drift_cause" TEXT,
ADD COLUMN     "qb_drifted_txn_id" TEXT;

COMMIT;
