-- A row's key is unique per organisation and source (QB_ENTRY_OWNERSHIP contract).
BEGIN;

-- DropIndex
DROP INDEX "payout_reconciliations_org_id_payout_gid_key";

-- CreateIndex
CREATE UNIQUE INDEX "payout_reconciliations_org_id_source_payout_gid_key" ON "payout_reconciliations"("org_id", "source", "payout_gid");

COMMIT;
