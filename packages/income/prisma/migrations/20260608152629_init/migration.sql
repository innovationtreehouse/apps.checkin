-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "payout_imports" (
    "id" SERIAL NOT NULL,
    "org_id" TEXT NOT NULL,
    "payout_date" TEXT NOT NULL,
    "total_cents" INTEGER NOT NULL,
    "payload" TEXT NOT NULL,
    "imported_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payout_imports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payouts" (
    "id" INTEGER NOT NULL,
    "org_id" TEXT NOT NULL,
    "shopify_payout_id" TEXT,
    "payout_date" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "charges_cents" INTEGER NOT NULL,
    "refunds_cents" INTEGER NOT NULL,
    "adjustments_cents" INTEGER NOT NULL,
    "marketplace_sales_tax_cents" INTEGER NOT NULL,
    "advances_cents" INTEGER NOT NULL,
    "reserved_funds_cents" INTEGER NOT NULL,
    "fees_cents" INTEGER NOT NULL,
    "retried_amount_cents" INTEGER NOT NULL,
    "total_cents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "bank_reference" TEXT,

    CONSTRAINT "payouts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payout_conflicts" (
    "id" SERIAL NOT NULL,
    "org_id" TEXT NOT NULL,
    "incoming_payload" TEXT NOT NULL,
    "existing_import_id" INTEGER NOT NULL,
    "reason" TEXT NOT NULL DEFAULT 'payload_mismatch',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMP(3),
    "resolved_by_user_id" INTEGER,

    CONSTRAINT "payout_conflicts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payout_import_files" (
    "id" SERIAL NOT NULL,
    "org_id" TEXT NOT NULL,
    "uploaded_by_user_id" INTEGER NOT NULL,
    "uploaded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "original_filename" TEXT NOT NULL,
    "file_hash" TEXT NOT NULL,
    "row_count" INTEGER NOT NULL DEFAULT 0,
    "inserted_count" INTEGER NOT NULL DEFAULT 0,
    "duplicate_count" INTEGER NOT NULL DEFAULT 0,
    "conflict_count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "payout_import_files_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shopify_import_files" (
    "id" SERIAL NOT NULL,
    "org_id" TEXT NOT NULL,
    "uploaded_by_user_id" INTEGER NOT NULL,
    "uploaded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "original_filename" TEXT NOT NULL,
    "file_hash" TEXT NOT NULL,
    "row_count" INTEGER NOT NULL DEFAULT 0,
    "new_order_count" INTEGER NOT NULL DEFAULT 0,
    "skipped_order_count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "shopify_import_files_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shopify_order_blobs" (
    "id" SERIAL NOT NULL,
    "org_id" TEXT NOT NULL,
    "purchase_id" TEXT NOT NULL,
    "paid_at" TEXT,
    "total_cents" INTEGER NOT NULL,
    "payload" TEXT NOT NULL,
    "import_file_id" INTEGER NOT NULL,
    "imported_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shopify_order_blobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shopify_customers" (
    "id" SERIAL NOT NULL,
    "org_id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "billing_name" TEXT,
    "billing_street" TEXT,
    "billing_address1" TEXT,
    "billing_address2" TEXT,
    "billing_company" TEXT,
    "billing_city" TEXT,
    "billing_zip" TEXT,
    "billing_province" TEXT,
    "billing_country" TEXT,
    "billing_phone" TEXT,
    "phone" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shopify_customers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shopify_orders" (
    "id" SERIAL NOT NULL,
    "org_id" TEXT NOT NULL,
    "purchase_id" TEXT NOT NULL,
    "shopify_numeric_id" TEXT,
    "customer_id" INTEGER NOT NULL,
    "financial_status" TEXT,
    "paid_at" TEXT,
    "fulfillment_status" TEXT,
    "fulfilled_at" TEXT,
    "cancelled_at" TEXT,
    "created_at" TEXT,
    "currency" TEXT,
    "subtotal_cents" INTEGER NOT NULL DEFAULT 0,
    "shipping_cents" INTEGER NOT NULL DEFAULT 0,
    "taxes_cents" INTEGER NOT NULL DEFAULT 0,
    "total_cents" INTEGER NOT NULL DEFAULT 0,
    "discount_code" TEXT,
    "discount_amount_cents" INTEGER NOT NULL DEFAULT 0,
    "refunded_amount_cents" INTEGER NOT NULL DEFAULT 0,
    "imported_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shopify_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shopify_order_line_items" (
    "id" SERIAL NOT NULL,
    "order_id" INTEGER NOT NULL,
    "org_id" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "name" TEXT NOT NULL,
    "price_cents" INTEGER NOT NULL DEFAULT 0,
    "compare_at_price_cents" INTEGER,
    "sku" TEXT,
    "discount_cents" INTEGER NOT NULL DEFAULT 0,
    "fulfillment_status" TEXT,

    CONSTRAINT "shopify_order_line_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payout_detail_import_files" (
    "id" SERIAL NOT NULL,
    "org_id" TEXT NOT NULL,
    "uploaded_by_user_id" INTEGER NOT NULL,
    "uploaded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "original_filename" TEXT NOT NULL,
    "file_hash" TEXT NOT NULL,
    "row_count" INTEGER NOT NULL DEFAULT 0,
    "inserted_count" INTEGER NOT NULL DEFAULT 0,
    "duplicate_count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "payout_detail_import_files_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shopify_payout_detail_blobs" (
    "id" SERIAL NOT NULL,
    "org_id" TEXT NOT NULL,
    "shopify_payout_id" TEXT NOT NULL,
    "payout_date" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "import_file_id" INTEGER NOT NULL,
    "imported_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shopify_payout_detail_blobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shopify_payout_line_items" (
    "id" SERIAL NOT NULL,
    "org_id" TEXT NOT NULL,
    "shopify_payout_id" TEXT NOT NULL,
    "transaction_date" TEXT NOT NULL,
    "transaction_type" TEXT NOT NULL,
    "order_ref" TEXT,
    "shopify_order_id" INTEGER,
    "payout_status" TEXT,
    "payout_date" TEXT NOT NULL,
    "amount_cents" INTEGER NOT NULL,
    "fee_cents" INTEGER NOT NULL,
    "net_cents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,

    CONSTRAINT "shopify_payout_line_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" SERIAL NOT NULL,
    "org_id" TEXT NOT NULL,
    "actor_user_id" INTEGER,
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
CREATE UNIQUE INDEX "payouts_org_id_payout_date_total_cents_key" ON "payouts"("org_id", "payout_date", "total_cents");

-- CreateIndex
CREATE UNIQUE INDEX "shopify_order_blobs_org_id_purchase_id_key" ON "shopify_order_blobs"("org_id", "purchase_id");

-- CreateIndex
CREATE UNIQUE INDEX "shopify_customers_org_id_email_key" ON "shopify_customers"("org_id", "email");

-- CreateIndex
CREATE UNIQUE INDEX "shopify_orders_org_id_purchase_id_key" ON "shopify_orders"("org_id", "purchase_id");

-- CreateIndex
CREATE UNIQUE INDEX "shopify_payout_detail_blobs_org_id_shopify_payout_id_key" ON "shopify_payout_detail_blobs"("org_id", "shopify_payout_id");

-- AddForeignKey
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_id_fkey" FOREIGN KEY ("id") REFERENCES "payout_imports"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payout_conflicts" ADD CONSTRAINT "payout_conflicts_existing_import_id_fkey" FOREIGN KEY ("existing_import_id") REFERENCES "payout_imports"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shopify_order_blobs" ADD CONSTRAINT "shopify_order_blobs_import_file_id_fkey" FOREIGN KEY ("import_file_id") REFERENCES "shopify_import_files"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shopify_orders" ADD CONSTRAINT "shopify_orders_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "shopify_customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shopify_order_line_items" ADD CONSTRAINT "shopify_order_line_items_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "shopify_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shopify_payout_detail_blobs" ADD CONSTRAINT "shopify_payout_detail_blobs_import_file_id_fkey" FOREIGN KEY ("import_file_id") REFERENCES "payout_detail_import_files"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shopify_payout_line_items" ADD CONSTRAINT "shopify_payout_line_items_shopify_order_id_fkey" FOREIGN KEY ("shopify_order_id") REFERENCES "shopify_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

