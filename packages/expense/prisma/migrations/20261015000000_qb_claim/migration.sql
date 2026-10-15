-- CreateTable
CREATE TABLE "qb_claim" (
    "id" SERIAL NOT NULL,
    "org_id" TEXT NOT NULL,
    "qb_txn_entity" TEXT NOT NULL,
    "qb_txn_id" TEXT NOT NULL,
    "claimed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "qb_claim_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "qb_claim_org_id_qb_txn_entity_qb_txn_id_key" ON "qb_claim"("org_id", "qb_txn_entity", "qb_txn_id");

-- Backfill every entry already held by an expense or a line; a line with no entity type
-- links to a Bill when its expense is a reimbursement, else a Purchase.
INSERT INTO "qb_claim" ("org_id", "qb_txn_entity", "qb_txn_id")
SELECT "org_id", "qb_txn_entity", "qb_txn_id" FROM "expenses"
WHERE "qb_txn_id" IS NOT NULL AND "qb_txn_entity" IS NOT NULL
UNION
SELECT e."org_id", COALESCE(li."qb_txn_entity", CASE WHEN e."needs_reimbursement" THEN 'Bill' ELSE 'Purchase' END), li."qb_txn_id"
FROM "expense_line_items" AS li JOIN "expenses" AS e ON e."id" = li."expense_id"
WHERE li."qb_txn_id" IS NOT NULL
ON CONFLICT DO NOTHING;
