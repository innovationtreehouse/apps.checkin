-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "system_data" (
    "id" INTEGER NOT NULL,
    "local_inventory_url" TEXT,

    CONSTRAINT "system_data_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "uploaded_files" (
    "id" SERIAL NOT NULL,
    "org_id" TEXT NOT NULL,
    "uploaded_by_user_id" INTEGER NOT NULL,
    "uploaded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "original_filename" TEXT NOT NULL,
    "file_blob" BYTEA,
    "file_hash" TEXT NOT NULL,
    "row_count" INTEGER NOT NULL DEFAULT 0,
    "new_row_count" INTEGER NOT NULL DEFAULT 0,
    "duplicate_row_count" INTEGER NOT NULL DEFAULT 0,
    "all_duplicate" BOOLEAN NOT NULL DEFAULT false,
    "blob_deleted" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "uploaded_files_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transactions" (
    "id" SERIAL NOT NULL,
    "org_id" TEXT NOT NULL,
    "uploaded_file_id" INTEGER NOT NULL,
    "transaction_id" TEXT NOT NULL,
    "imported_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "nonprofit_name" TEXT,
    "nonprofit_id" TEXT,
    "disbursement_id" TEXT,
    "disbursement_date" TEXT,
    "bank_date" TEXT,
    "bank_reference_id" TEXT,
    "payment_method" TEXT,
    "disbursement_from" TEXT,
    "project_name" TEXT,
    "project_id" TEXT,
    "donation_date" TEXT,
    "donation_frequency" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "foreign_exchange_rate" DOUBLE PRECISION,
    "company_name" TEXT,
    "corporate_peer_campaign" TEXT,
    "donation_amount_cents" INTEGER NOT NULL DEFAULT 0,
    "match_amount_cents" INTEGER NOT NULL DEFAULT 0,
    "cause_support_fee_cents" INTEGER NOT NULL DEFAULT 0,
    "merchant_fee_cents" INTEGER NOT NULL DEFAULT 0,
    "check_fee_cents" INTEGER NOT NULL DEFAULT 0,
    "donation_method" TEXT,
    "donation_type" TEXT,
    "donor_first_name" TEXT,
    "donor_last_name" TEXT,
    "donor_comment" TEXT,
    "owner_id" INTEGER,
    "owner_assigned_at" TIMESTAMP(3),
    "owner_assigned_by_user_id" INTEGER,
    "is_organizational_level" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transaction_comment_rules" (
    "id" SERIAL NOT NULL,
    "org_id" TEXT NOT NULL,
    "comment" TEXT NOT NULL,
    "owner_id" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_user_id" INTEGER NOT NULL,

    CONSTRAINT "transaction_comment_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account_map" (
    "id" SERIAL NOT NULL,
    "org_id" TEXT NOT NULL,
    "company_name" TEXT NOT NULL,
    "corporate_peer_campaign" TEXT NOT NULL,
    "donation_method" TEXT,
    "donation_type" TEXT,
    "donation_account" TEXT NOT NULL,
    "match_account" TEXT NOT NULL,
    "fees_account" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "account_map_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "disbursement_holds" (
    "id" SERIAL NOT NULL,
    "org_id" TEXT NOT NULL,
    "disbursement_id" TEXT NOT NULL,
    "transaction_id" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "matched_rows" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMP(3),

    CONSTRAINT "disbursement_holds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "disbursement_events" (
    "id" SERIAL NOT NULL,
    "org_id" TEXT NOT NULL,
    "disbursement_id" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "disbursement_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "disbursement_snapshots" (
    "org_id" TEXT NOT NULL,
    "disbursement_id" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "context" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "disbursement_snapshots_pkey" PRIMARY KEY ("org_id","disbursement_id")
);

-- CreateTable
CREATE TABLE "workflow_events" (
    "id" SERIAL NOT NULL,
    "org_id" TEXT NOT NULL,
    "disbursement_id" TEXT,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT,
    "event_type" TEXT NOT NULL,
    "actor_user_id" INTEGER,
    "actor_username" TEXT,
    "correlation_id" TEXT,
    "payload" TEXT,
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workflow_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "transactions_org_id_transaction_id_key" ON "transactions"("org_id", "transaction_id");

-- CreateIndex
CREATE UNIQUE INDEX "transaction_comment_rules_org_id_comment_key" ON "transaction_comment_rules"("org_id", "comment");

-- CreateIndex
CREATE UNIQUE INDEX "disbursement_events_org_id_disbursement_id_key" ON "disbursement_events"("org_id", "disbursement_id");

-- CreateIndex
CREATE INDEX "workflow_events_org_id_disbursement_id_occurred_at_idx" ON "workflow_events"("org_id", "disbursement_id", "occurred_at");

-- CreateIndex
CREATE INDEX "workflow_events_org_id_occurred_at_idx" ON "workflow_events"("org_id", "occurred_at");

-- AddForeignKey
ALTER TABLE "disbursement_holds" ADD CONSTRAINT "disbursement_holds_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "transactions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

