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
CREATE TABLE "income_item_categories" (
    "id" SERIAL NOT NULL,
    "org_id" TEXT NOT NULL,
    "variant_id" TEXT NOT NULL,
    "budget_owner_id" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "income_item_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "qb_match_exclusion" (
    "id" SERIAL NOT NULL,
    "org_id" TEXT NOT NULL,
    "qb_txn_id" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "excluded_by_user_id" INTEGER NOT NULL,
    "excluded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "qb_match_exclusion_pkey" PRIMARY KEY ("id")
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

-- CreateIndex
CREATE UNIQUE INDEX "income_item_categories_org_id_variant_id_key" ON "income_item_categories"("org_id", "variant_id");

-- CreateIndex
CREATE UNIQUE INDEX "qb_match_exclusion_org_id_qb_txn_id_key" ON "qb_match_exclusion"("org_id", "qb_txn_id");

