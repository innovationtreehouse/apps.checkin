-- AlterTable
ALTER TABLE "expenses" ADD COLUMN "qb_match_state" TEXT NOT NULL DEFAULT 'UNMATCHED',
ADD COLUMN "qb_txn_id" TEXT,
ADD COLUMN "qb_vendor_id" TEXT,
ADD COLUMN "is_test_data" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "expense_line_items" ADD COLUMN "qb_account_id" TEXT;

-- CreateTable
CREATE TABLE "reimbursee_vendor" (
    "id" SERIAL NOT NULL,
    "org_id" TEXT NOT NULL,
    "reimbursee_person_id" INTEGER NOT NULL,
    "qb_vendor_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reimbursee_vendor_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "expenses_qb_txn_id_key" ON "expenses"("qb_txn_id");

-- CreateIndex
CREATE UNIQUE INDEX "reimbursee_vendor_org_id_reimbursee_person_id_key" ON "reimbursee_vendor"("org_id", "reimbursee_person_id");
