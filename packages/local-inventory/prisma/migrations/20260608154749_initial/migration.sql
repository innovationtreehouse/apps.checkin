-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "locations" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,

    CONSTRAINT "locations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "org_items" (
    "id" SERIAL NOT NULL,
    "org_id" TEXT NOT NULL,
    "gtin13" TEXT NOT NULL,
    "existing_quantity" INTEGER NOT NULL DEFAULT 0,
    "desired_quantity" INTEGER NOT NULL DEFAULT 0,
    "location_id" INTEGER,
    "backstock_location_id" INTEGER,

    CONSTRAINT "org_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_log" (
    "id" SERIAL NOT NULL,
    "org_id" TEXT NOT NULL,
    "user_id" INTEGER,
    "changed_at" TIMESTAMP(3) NOT NULL,
    "change_type" TEXT NOT NULL,
    "gtin13" TEXT NOT NULL,
    "field_changed" TEXT NOT NULL,
    "value_before" TEXT,
    "value_after" TEXT,
    "receipt_id" TEXT,

    CONSTRAINT "inventory_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "receive_queue" (
    "id" SERIAL NOT NULL,
    "org_id" TEXT NOT NULL,
    "gtin13" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "retailer" TEXT NOT NULL DEFAULT '',
    "receipt_id" TEXT NOT NULL,
    "line_item_id" INTEGER NOT NULL,
    "queued_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "fulfilled_at" TIMESTAMP(3),

    CONSTRAINT "receive_queue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settings_data" (
    "id" INTEGER NOT NULL,
    "global_server_url" TEXT,
    "poll_interval_minutes" INTEGER NOT NULL DEFAULT 3,
    "poll_window_start" TEXT NOT NULL DEFAULT '00:00',
    "poll_window_end" TEXT NOT NULL DEFAULT '23:59',

    CONSTRAINT "settings_data_pkey" PRIMARY KEY ("id")
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
    "resolved_to_gtin13" TEXT,

    CONSTRAINT "provisional_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_merge_conflicts" (
    "id" SERIAL NOT NULL,
    "org_id" TEXT NOT NULL,
    "provisional_gtin13" TEXT NOT NULL,
    "real_gtin13" TEXT NOT NULL,
    "conflict_type" TEXT NOT NULL,
    "provisional_conversion_factor" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "existing_conversion_factor" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "resolved_by_user_id" INTEGER,
    "resolved_at" TIMESTAMP(3),
    "resolution" TEXT,
    "source_event_id" INTEGER NOT NULL,

    CONSTRAINT "inventory_merge_conflicts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "received_org_events" (
    "id" SERIAL NOT NULL,
    "org_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "received_at" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "failure_reason" TEXT,

    CONSTRAINT "received_org_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provisional_item_log" (
    "id" SERIAL NOT NULL,
    "org_id" TEXT NOT NULL,
    "provisional_item_id" INTEGER,
    "gtin13" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "notes" TEXT,
    "performed_by" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "provisional_item_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "received_inventory_deltas" (
    "id" SERIAL NOT NULL,
    "org_id" TEXT NOT NULL,
    "receipt_id" TEXT NOT NULL,
    "delta_json" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "failure_reason" TEXT,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "received_inventory_deltas_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "location_log" (
    "id" SERIAL NOT NULL,
    "org_id" TEXT NOT NULL,
    "location_id" INTEGER NOT NULL,
    "user_id" INTEGER,
    "changed_at" TIMESTAMP(3) NOT NULL,
    "event_type" TEXT NOT NULL,
    "name_before" TEXT,
    "name_after" TEXT,

    CONSTRAINT "location_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "org_items_org_gtin_idx" ON "org_items"("org_id", "gtin13");

-- CreateIndex
CREATE UNIQUE INDEX "provisional_items_provisional_gtin13_key" ON "provisional_items"("provisional_gtin13");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_merge_conflicts_source_event_id_key" ON "inventory_merge_conflicts"("source_event_id");

-- CreateIndex
CREATE UNIQUE INDEX "received_inventory_deltas_receipt_id_key" ON "received_inventory_deltas"("receipt_id");

-- AddForeignKey
ALTER TABLE "org_items" ADD CONSTRAINT "org_items_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "org_items" ADD CONSTRAINT "org_items_backstock_location_id_fkey" FOREIGN KEY ("backstock_location_id") REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

