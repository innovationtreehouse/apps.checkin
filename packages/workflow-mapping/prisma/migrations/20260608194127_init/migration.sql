-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "system_data" (
    "id" INTEGER NOT NULL,
    "expense_app_url" TEXT,
    "local_inventory_url" TEXT,
    "global_server_url" TEXT,
    "poll_interval_minutes" INTEGER NOT NULL DEFAULT 3,
    "poll_window_start" TEXT NOT NULL DEFAULT '00:00',
    "poll_window_end" TEXT NOT NULL DEFAULT '23:59',

    CONSTRAINT "system_data_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "received_org_events" (
    "id" INTEGER NOT NULL,
    "org_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "received_at" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "failure_reason" TEXT,

    CONSTRAINT "received_org_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "received_receipts" (
    "id" SERIAL NOT NULL,
    "org_id" TEXT NOT NULL,
    "receipt_id" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'pending_review',
    "receipt_json" TEXT NOT NULL,
    "validation_notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "received_receipts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "received_receipt_line_statuses" (
    "id" SERIAL NOT NULL,
    "received_receipt_id" INTEGER NOT NULL,
    "receipt_line_item_id" INTEGER NOT NULL,
    "recognition_status" TEXT NOT NULL DEFAULT 'unrecognized',
    "assigned_gtin13" TEXT,
    "provisional_item_gtin13" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "received_receipt_line_statuses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provisional_items" (
    "id" SERIAL NOT NULL,
    "provisional_gtin13" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "proposed_category_id" INTEGER,
    "proposed_subcategory_id" INTEGER,
    "usage_behavior" TEXT NOT NULL,
    "proposed_by_user_id" INTEGER,
    "org_id" TEXT NOT NULL,
    "proposed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "reviewed_at" TIMESTAMP(3),
    "rejection_reason" TEXT,
    "canonical_gtin13" TEXT,

    CONSTRAINT "provisional_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_audit_log" (
    "id" SERIAL NOT NULL,
    "org_id" TEXT NOT NULL,
    "actor_user_id" INTEGER,
    "event_type" TEXT NOT NULL,
    "received_receipt_id" INTEGER,
    "line_status_id" INTEGER,
    "from_state" TEXT,
    "to_state" TEXT,
    "details" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workflow_audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "received_receipts_receipt_id_key" ON "received_receipts"("receipt_id");

-- CreateIndex
CREATE UNIQUE INDEX "received_receipt_line_statuses_received_receipt_id_receipt__key" ON "received_receipt_line_statuses"("received_receipt_id", "receipt_line_item_id");

-- CreateIndex
CREATE UNIQUE INDEX "provisional_items_provisional_gtin13_key" ON "provisional_items"("provisional_gtin13");

-- AddForeignKey
ALTER TABLE "received_receipt_line_statuses" ADD CONSTRAINT "received_receipt_line_statuses_received_receipt_id_fkey" FOREIGN KEY ("received_receipt_id") REFERENCES "received_receipts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

