-- CreateTable
CREATE TABLE "payout_reconciliations" (
    "id" SERIAL NOT NULL,
    "org_id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "payout_date" TEXT NOT NULL,
    "payout_net_cents" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "kind" TEXT,
    "resolution" TEXT,
    "deposit_id" TEXT,
    "deposit_txn_date" TEXT,
    "deposit_total_cents" INTEGER,
    "reason" TEXT,
    "resolved_by_user_id" INTEGER,
    "resolved_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payout_reconciliations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "payout_reconciliations_org_id_status_idx" ON "payout_reconciliations"("org_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "payout_reconciliations_org_id_key_key" ON "payout_reconciliations"("org_id", "key");

-- CreateIndex
CREATE UNIQUE INDEX "payout_reconciliations_org_id_deposit_id_key" ON "payout_reconciliations"("org_id", "deposit_id");
