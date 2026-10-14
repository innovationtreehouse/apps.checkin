-- AlterTable
ALTER TABLE "expense_line_items" ADD COLUMN "qb_txn_entity" TEXT;

-- Backfill: a reimbursement line links to a Bill, every other line to a Purchase.
UPDATE "expense_line_items" AS li
SET "qb_txn_entity" = CASE WHEN e."needs_reimbursement" THEN 'Bill' ELSE 'Purchase' END
FROM "expenses" AS e
WHERE li."expense_id" = e."id" AND li."qb_txn_id" IS NOT NULL;
