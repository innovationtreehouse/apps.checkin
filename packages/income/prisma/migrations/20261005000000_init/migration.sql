-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "payout_reconciliations" (
    "id" SERIAL NOT NULL,
    "org_id" TEXT NOT NULL,
    "payout_gid" TEXT NOT NULL,
    "payout_date" TEXT NOT NULL,
    "payout_net_cents" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "kind" TEXT,
    "resolution" TEXT,
    "origin" TEXT,
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

-- CreateTable
CREATE TABLE "audit_log" (
    "id" SERIAL NOT NULL,
    "org_id" TEXT NOT NULL,
    "actor_user_id" INTEGER,
    "actor_username" TEXT,
    "action" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT,
    "before" TEXT,
    "after" TEXT,
    "reason" TEXT,
    "correlation_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "payout_reconciliations_org_id_status_idx" ON "payout_reconciliations"("org_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "payout_reconciliations_org_id_payout_gid_key" ON "payout_reconciliations"("org_id", "payout_gid");

-- CreateIndex
CREATE UNIQUE INDEX "payout_reconciliations_org_id_deposit_id_key" ON "payout_reconciliations"("org_id", "deposit_id");

