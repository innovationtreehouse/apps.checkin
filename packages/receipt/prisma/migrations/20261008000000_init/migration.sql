-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "org_settings" (
    "org_id" TEXT NOT NULL,
    "tax_exempt" BOOLEAN NOT NULL DEFAULT false,
    "require_finance_review_with_tax" BOOLEAN NOT NULL DEFAULT true,
    "enforce_receipt_age_limit" BOOLEAN NOT NULL DEFAULT true,
    "receipt_age_limit_days" INTEGER NOT NULL DEFAULT 90,

    CONSTRAINT "org_settings_pkey" PRIMARY KEY ("org_id")
);

-- CreateTable
CREATE TABLE "receipts" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "uploaded_by_user_id" INTEGER NOT NULL,
    "uploaded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "file_blob" BYTEA NOT NULL,
    "file_hash" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "needs_reimbursement" BOOLEAN NOT NULL DEFAULT false,
    "reimbursement_for" TEXT,
    "reimbursee_person_id" INTEGER,
    "intake_source" TEXT NOT NULL DEFAULT 'upload',
    "is_in_kind" BOOLEAN NOT NULL DEFAULT false,
    "donor_first_name" TEXT,
    "donor_last_name" TEXT,
    "donor_company_name" TEXT,
    "donor_sync" TEXT NOT NULL DEFAULT 'none',
    "pushed_at" TIMESTAMP(3),

    CONSTRAINT "receipts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "receipt_details" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "retailer" TEXT,
    "receipt_number" TEXT,
    "order_number" TEXT,
    "receipt_date" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "shipping_cents" INTEGER NOT NULL DEFAULT 0,
    "tax_cents" INTEGER NOT NULL DEFAULT 0,
    "discount_cents" INTEGER NOT NULL DEFAULT 0,
    "receipt_total_cents" INTEGER,
    "state" TEXT NOT NULL DEFAULT 'uploaded',
    "ocr_started_at" TIMESTAMP(3),
    "duplicate_flagged_at" TIMESTAMP(3),
    "duplicate_flag_cleared_at" TIMESTAMP(3),
    "duplicate_suspect_receipt_id" TEXT,
    "duplicate_suspect_is_rejected" BOOLEAN,
    "validation_notes" TEXT,
    "approved_at" TIMESTAMP(3),
    "reviewed_at" TIMESTAMP(3),
    "qb_txn_id" TEXT,
    "qb_entity" TEXT,
    "import_source_id" TEXT,

    CONSTRAINT "receipt_details_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "receipt_line_items" (
    "id" SERIAL NOT NULL,
    "receipt_id" TEXT NOT NULL,
    "line_number" INTEGER NOT NULL,
    "description" TEXT NOT NULL,
    "part_number" TEXT,
    "manufacturer" TEXT,
    "quantity" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "unit_price_cents" INTEGER NOT NULL,
    "total_price_cents" INTEGER NOT NULL,
    "is_delayed" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "receipt_line_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "receipt_audit_log" (
    "id" SERIAL NOT NULL,
    "receipt_id" TEXT NOT NULL,
    "user_id" INTEGER,
    "username" TEXT,
    "changed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "action" TEXT NOT NULL,
    "field_changed" TEXT,
    "value_before" TEXT,
    "value_after" TEXT,
    "line_item_id" INTEGER,

    CONSTRAINT "receipt_audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "receipt_mail_items" (
    "id" SERIAL NOT NULL,
    "org_id" TEXT NOT NULL,
    "gmail_message_id" TEXT NOT NULL,
    "attachment_hash" TEXT NOT NULL,
    "received_at" TIMESTAMP(3) NOT NULL,
    "sender_address" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'held',
    "file_blob" BYTEA,
    "mime_type" TEXT,
    "receipt_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "receipt_mail_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "receipts_org_id_file_hash_idx" ON "receipts"("org_id", "file_hash");

-- CreateIndex
CREATE INDEX "receipts_org_id_uploaded_by_user_id_idx" ON "receipts"("org_id", "uploaded_by_user_id");

-- CreateIndex
CREATE INDEX "receipt_details_org_id_state_idx" ON "receipt_details"("org_id", "state");

-- CreateIndex
CREATE UNIQUE INDEX "receipt_details_org_id_import_source_id_key" ON "receipt_details"("org_id", "import_source_id");

-- CreateIndex
CREATE UNIQUE INDEX "receipt_line_items_receipt_id_line_number_key" ON "receipt_line_items"("receipt_id", "line_number");

-- CreateIndex
CREATE INDEX "receipt_audit_log_receipt_id_idx" ON "receipt_audit_log"("receipt_id");

-- CreateIndex
CREATE INDEX "receipt_mail_items_org_id_status_idx" ON "receipt_mail_items"("org_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "receipt_mail_items_gmail_message_id_attachment_hash_key" ON "receipt_mail_items"("gmail_message_id", "attachment_hash");

-- AddForeignKey
ALTER TABLE "receipt_details" ADD CONSTRAINT "receipt_details_id_fkey" FOREIGN KEY ("id") REFERENCES "receipts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipt_line_items" ADD CONSTRAINT "receipt_line_items_receipt_id_fkey" FOREIGN KEY ("receipt_id") REFERENCES "receipts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipt_audit_log" ADD CONSTRAINT "receipt_audit_log_receipt_id_fkey" FOREIGN KEY ("receipt_id") REFERENCES "receipts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipt_audit_log" ADD CONSTRAINT "receipt_audit_log_line_item_id_fkey" FOREIGN KEY ("line_item_id") REFERENCES "receipt_line_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

