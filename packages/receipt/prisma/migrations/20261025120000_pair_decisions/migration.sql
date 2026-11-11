-- Finance's duplicate decisions, one row per unordered pair of receipts.
BEGIN;

CREATE TABLE "receipt_pair_decisions" (
    "id" SERIAL NOT NULL,
    "org_id" TEXT NOT NULL,
    "receipt_id" TEXT NOT NULL,
    "other_receipt_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "copy_receipt_id" TEXT,
    "decided_by_user_id" INTEGER NOT NULL,
    "decided_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "note" TEXT,

    CONSTRAINT "receipt_pair_decisions_pkey" PRIMARY KEY ("id"),
    -- The pair is stored once, lowest id first, so (A, B) and (B, A) share the unique key.
    CONSTRAINT "receipt_pair_decisions_ordered_check" CHECK ("receipt_id" < "other_receipt_id"),
    CONSTRAINT "receipt_pair_decisions_kind_check" CHECK ("kind" IN ('different', 'copy_of')),
    -- copy_of names which of the two is the copy; different names none.
    CONSTRAINT "receipt_pair_decisions_copy_check" CHECK (
        ("kind" = 'copy_of' AND "copy_receipt_id" IS NOT NULL AND "copy_receipt_id" IN ("receipt_id", "other_receipt_id"))
        OR ("kind" = 'different' AND "copy_receipt_id" IS NULL)
    )
);

CREATE INDEX "receipt_pair_decisions_other_receipt_id_idx" ON "receipt_pair_decisions"("other_receipt_id");

CREATE UNIQUE INDEX "receipt_pair_decisions_receipt_id_other_receipt_id_key" ON "receipt_pair_decisions"("receipt_id", "other_receipt_id");

ALTER TABLE "receipt_pair_decisions" ADD CONSTRAINT "receipt_pair_decisions_receipt_id_fkey" FOREIGN KEY ("receipt_id") REFERENCES "receipts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "receipt_pair_decisions" ADD CONSTRAINT "receipt_pair_decisions_other_receipt_id_fkey" FOREIGN KEY ("other_receipt_id") REFERENCES "receipts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

COMMIT;
