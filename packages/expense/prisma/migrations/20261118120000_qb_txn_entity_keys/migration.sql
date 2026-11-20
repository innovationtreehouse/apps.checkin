-- QuickBooks ids are unique per entity type only, so every QuickBooks-transaction key carries its type.
-- qb_match_exclusion.qb_txn_entity stays nullable: a null row excludes the id for both types.
BEGIN;

DROP INDEX "expense_line_items_qb_txn_id_key";
CREATE UNIQUE INDEX "expense_line_items_qb_txn_entity_qb_txn_id_key" ON "expense_line_items"("qb_txn_entity", "qb_txn_id");

ALTER TABLE "qb_match_exclusion" ADD COLUMN "qb_txn_entity" TEXT;
DROP INDEX "qb_match_exclusion_org_id_qb_txn_id_key";
CREATE UNIQUE INDEX "qb_match_exclusion_org_id_qb_txn_entity_qb_txn_id_key" ON "qb_match_exclusion"("org_id", "qb_txn_entity", "qb_txn_id");

ALTER TABLE "capital_assets" ADD COLUMN "source_qb_txn_entity" TEXT;

COMMIT;
