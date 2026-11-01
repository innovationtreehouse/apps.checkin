-- A row's key is unique per source. Every (org, key) pair already unique stays unique per (org, source, key).
BEGIN;

CREATE UNIQUE INDEX "payout_reconciliations_org_id_source_payout_gid_key" ON "payout_reconciliations"("org_id", "source", "payout_gid");

DROP INDEX "payout_reconciliations_org_id_payout_gid_key";

COMMIT;
