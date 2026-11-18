-- Line items and audit rows carry their expense's org; QuickBooks entry keys are per org.
-- org_id stays nullable this release: the previous release's code inserts rows without it while it drains.
BEGIN;

ALTER TABLE "expense_line_items" ADD COLUMN "org_id" TEXT;
UPDATE "expense_line_items" li SET "org_id" = e."org_id" FROM "expenses" e WHERE e."id" = li."expense_id";

ALTER TABLE "expense_audit_log" ADD COLUMN "org_id" TEXT;
UPDATE "expense_audit_log" a SET "org_id" = e."org_id" FROM "expenses" e WHERE e."id" = a."expense_id";
CREATE INDEX "expense_audit_log_org_id_action_changed_at_idx" ON "expense_audit_log"("org_id", "action", "changed_at");

DROP INDEX "expenses_qb_txn_entity_qb_txn_id_key";
CREATE UNIQUE INDEX "expenses_org_id_qb_txn_entity_qb_txn_id_key" ON "expenses"("org_id", "qb_txn_entity", "qb_txn_id");

COMMIT;
