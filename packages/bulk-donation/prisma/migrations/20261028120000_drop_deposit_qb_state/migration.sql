-- Income owns every deposit (QB_ENTRY_OWNERSHIP contract): donation's own QuickBooks state goes.
-- Drops are safe: prod holds no QuickBooks lane data for donation.
BEGIN;

-- DropIndex
DROP INDEX "disbursement_events_org_id_qb_match_state_idx";

-- DropIndex
DROP INDEX "disbursement_events_org_id_qb_txn_id_key";

-- AlterTable
ALTER TABLE "disbursement_events" DROP COLUMN "qb_match_state",
DROP COLUMN "qb_txn_id",
DROP COLUMN "qb_deposit_total_cents",
DROP COLUMN "qb_deposit_txn_date",
DROP COLUMN "qb_drifted_txn_id",
DROP COLUMN "qb_drift_cause",
DROP COLUMN "qb_create_attempted_at",
DROP COLUMN "qb_note";

-- AlterTable
ALTER TABLE "donation_org_settings" DROP COLUMN "qb_posting_on_at",
DROP COLUMN "deposits_handed_over_at";

COMMIT;
