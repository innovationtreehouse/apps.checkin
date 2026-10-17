-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "settingsData" (
    "id" INTEGER NOT NULL,
    "global_server_url" TEXT,
    "poll_interval_minutes" INTEGER NOT NULL DEFAULT 3,
    "poll_window_start" TEXT NOT NULL DEFAULT '00:00',
    "poll_window_end" TEXT NOT NULL DEFAULT '23:59',

    CONSTRAINT "settingsData_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "org_settings" (
    "org_id" TEXT NOT NULL,
    "capital_total_threshold_cents" INTEGER NOT NULL DEFAULT 0,
    "capital_line_item_threshold_cents" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "org_settings_pkey" PRIMARY KEY ("org_id")
);

-- CreateTable
CREATE TABLE "expenses" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "submitter_id" INTEGER NOT NULL,
    "vendor_name" TEXT,
    "receipt_number" TEXT,
    "order_number" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "tax_cents" INTEGER NOT NULL DEFAULT 0,
    "shipping_cents" INTEGER NOT NULL DEFAULT 0,
    "discount_cents" INTEGER NOT NULL DEFAULT 0,
    "receipt_total_cents" INTEGER NOT NULL,
    "receipt_date" TEXT,
    "needs_reimbursement" BOOLEAN NOT NULL DEFAULT false,
    "reimbursement_for" TEXT,
    "submitted_at" TIMESTAMP(3) NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'pending',

    CONSTRAINT "expenses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "expense_line_items" (
    "id" SERIAL NOT NULL,
    "expense_id" TEXT NOT NULL,
    "receipt_line_item_id" INTEGER NOT NULL,
    "line_number" INTEGER NOT NULL,
    "description" TEXT NOT NULL,
    "part_number" TEXT,
    "manufacturer" TEXT,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "unit_price_cents" INTEGER NOT NULL,
    "total_price_cents" INTEGER NOT NULL,
    "gtin13" TEXT,
    "is_delayed" BOOLEAN NOT NULL DEFAULT false,
    "is_capital" BOOLEAN NOT NULL DEFAULT false,
    "capital_owner_id" INTEGER,
    "depreciation_years" INTEGER,
    "manual_qb_account" TEXT,
    "allocated_tax_cents" INTEGER,
    "allocated_shipping_cents" INTEGER,
    "allocated_discount_cents" INTEGER,

    CONSTRAINT "expense_line_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "line_item_owner_approvals" (
    "id" SERIAL NOT NULL,
    "expense_id" TEXT NOT NULL,
    "line_item_id" INTEGER NOT NULL,
    "owner_id" INTEGER,
    "budget_owner_user_id" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "decided_at" TIMESTAMP(3),
    "decided_by_user_id" INTEGER,
    "notes" TEXT,

    CONSTRAINT "line_item_owner_approvals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account_mapping" (
    "id" SERIAL NOT NULL,
    "org_id" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "subcategory" TEXT NOT NULL,
    "part_number" TEXT NOT NULL,
    "is_delayed" BOOLEAN,
    "is_capital" BOOLEAN,
    "qb_account" TEXT NOT NULL,

    CONSTRAINT "account_mapping_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "expense_holds" (
    "id" SERIAL NOT NULL,
    "org_id" TEXT NOT NULL,
    "expense_id" TEXT NOT NULL,
    "line_item_id" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "matched_rows" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMP(3),

    CONSTRAINT "expense_holds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "expense_events" (
    "id" SERIAL NOT NULL,
    "org_id" TEXT NOT NULL,
    "expense_id" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "expense_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "expense_qb_accounts" (
    "id" SERIAL NOT NULL,
    "org_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "qb_account" TEXT NOT NULL,

    CONSTRAINT "expense_qb_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "expense_audit_log" (
    "id" SERIAL NOT NULL,
    "expense_id" TEXT NOT NULL,
    "user_id" INTEGER NOT NULL,
    "username" TEXT,
    "changed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "action" TEXT NOT NULL,
    "field_changed" TEXT,
    "value_before" TEXT,
    "value_after" TEXT,
    "line_item_id" INTEGER,
    "notes" TEXT,

    CONSTRAINT "expense_audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "part_owner_map" (
    "id" SERIAL NOT NULL,
    "org_id" TEXT NOT NULL,
    "gtin13" TEXT NOT NULL,
    "owner_id" INTEGER NOT NULL,

    CONSTRAINT "part_owner_map_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provisional_item_maps" (
    "id" SERIAL NOT NULL,
    "provisional_gtin13" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "proposed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewed_at" TIMESTAMP(3),
    "rejection_reason" TEXT,
    "resolved_to_gtin13" TEXT,

    CONSTRAINT "provisional_item_maps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "received_expense_payloads" (
    "id" SERIAL NOT NULL,
    "org_id" TEXT NOT NULL,
    "receipt_id" TEXT NOT NULL,
    "payload_json" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "failure_reason" TEXT,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "received_expense_payloads_pkey" PRIMARY KEY ("id")
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

-- CreateIndex
CREATE UNIQUE INDEX "expense_events_org_id_expense_id_key" ON "expense_events"("org_id", "expense_id");

-- CreateIndex
CREATE UNIQUE INDEX "part_owner_map_org_id_gtin13_key" ON "part_owner_map"("org_id", "gtin13");

-- CreateIndex
CREATE UNIQUE INDEX "provisional_item_maps_org_id_provisional_gtin13_key" ON "provisional_item_maps"("org_id", "provisional_gtin13");

-- CreateIndex
CREATE UNIQUE INDEX "received_expense_payloads_receipt_id_key" ON "received_expense_payloads"("receipt_id");

-- AddForeignKey
ALTER TABLE "expense_line_items" ADD CONSTRAINT "expense_line_items_expense_id_fkey" FOREIGN KEY ("expense_id") REFERENCES "expenses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "line_item_owner_approvals" ADD CONSTRAINT "line_item_owner_approvals_expense_id_fkey" FOREIGN KEY ("expense_id") REFERENCES "expenses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "line_item_owner_approvals" ADD CONSTRAINT "line_item_owner_approvals_line_item_id_fkey" FOREIGN KEY ("line_item_id") REFERENCES "expense_line_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expense_holds" ADD CONSTRAINT "expense_holds_expense_id_fkey" FOREIGN KEY ("expense_id") REFERENCES "expenses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expense_holds" ADD CONSTRAINT "expense_holds_line_item_id_fkey" FOREIGN KEY ("line_item_id") REFERENCES "expense_line_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expense_audit_log" ADD CONSTRAINT "expense_audit_log_expense_id_fkey" FOREIGN KEY ("expense_id") REFERENCES "expenses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expense_audit_log" ADD CONSTRAINT "expense_audit_log_line_item_id_fkey" FOREIGN KEY ("line_item_id") REFERENCES "expense_line_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

