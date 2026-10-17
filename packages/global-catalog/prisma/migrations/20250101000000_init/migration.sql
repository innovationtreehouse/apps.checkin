-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "categories" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "letter" TEXT NOT NULL,
    "archived_at" TIMESTAMP(3),

    CONSTRAINT "categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subcategories" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "category_id" INTEGER NOT NULL,
    "archived_at" TIMESTAMP(3),

    CONSTRAINT "subcategories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "items" (
    "gtin13" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category_id" INTEGER NOT NULL,
    "subcategory_id" INTEGER NOT NULL,
    "sequence" INTEGER NOT NULL,
    "usage_behavior" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_user_id" INTEGER,
    "updated_by_user_id" INTEGER,
    "archived_at" TIMESTAMP(3),

    CONSTRAINT "items_pkey" PRIMARY KEY ("gtin13")
);

-- CreateTable
CREATE TABLE "item_references" (
    "id" SERIAL NOT NULL,
    "gtin13" TEXT NOT NULL,
    "part_number" TEXT,
    "description_normalized" TEXT,
    "manufacturer" TEXT,
    "retailer" TEXT,
    "url" TEXT,
    "conversion_factor" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "conversion_version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_user_id" INTEGER,
    "updated_by_user_id" INTEGER,
    "archived_at" TIMESTAMP(3),

    CONSTRAINT "item_references_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reference_conflicts" (
    "id" SERIAL NOT NULL,
    "item_reference_id" INTEGER NOT NULL,
    "existing_gtin13" TEXT NOT NULL,
    "proposed_gtin13" TEXT NOT NULL,
    "manufacturer" TEXT,
    "retailer" TEXT,
    "part_number" TEXT,
    "description" TEXT,
    "receipt_id" TEXT NOT NULL,
    "line_item_id" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMP(3),
    "resolution" TEXT,
    "resolved_by_user_id" INTEGER,

    CONSTRAINT "reference_conflicts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "item_reference_proposals" (
    "id" SERIAL NOT NULL,
    "part_number" TEXT,
    "description" TEXT,
    "retailer" TEXT,
    "manufacturer" TEXT,
    "gtin13" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "org_name" TEXT NOT NULL DEFAULT '',
    "local_user_id" INTEGER NOT NULL,
    "proposed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "reviewed_by_user_id" INTEGER,
    "reviewed_at" TIMESTAMP(3),
    "rejection_reason" TEXT,
    "superseded_by_proposal_id" INTEGER,
    "conversion_factor" DOUBLE PRECISION NOT NULL DEFAULT 1.0,

    CONSTRAINT "item_reference_proposals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversion_challenges" (
    "id" SERIAL NOT NULL,
    "item_reference_id" INTEGER NOT NULL,
    "local_user_id" INTEGER NOT NULL,
    "org_id" TEXT NOT NULL,
    "org_name" TEXT NOT NULL DEFAULT '',
    "current_factor" DOUBLE PRECISION NOT NULL,
    "proposed_factor" DOUBLE PRECISION NOT NULL,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "reviewed_by_user_id" INTEGER,
    "reviewed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conversion_challenges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provisional_part_sequence" (
    "id" SERIAL NOT NULL,

    CONSTRAINT "provisional_part_sequence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provisional_items" (
    "id" SERIAL NOT NULL,
    "provisional_gtin13" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "org_name" TEXT NOT NULL DEFAULT '',
    "local_user_id" INTEGER NOT NULL,
    "proposed_name" TEXT NOT NULL,
    "proposed_category_id" INTEGER,
    "proposed_subcategory_id" INTEGER,
    "proposed_usage_behavior" TEXT NOT NULL,
    "part_number" TEXT,
    "manufacturer" TEXT,
    "retailer" TEXT,
    "proposed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "reviewed_by_user_id" INTEGER,
    "reviewed_at" TIMESTAMP(3),
    "rejection_reason" TEXT,
    "result_gtin13" TEXT,

    CONSTRAINT "provisional_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provisional_part_mapping_log" (
    "id" SERIAL NOT NULL,
    "org_id" TEXT NOT NULL,
    "provisional_gtin13" TEXT NOT NULL,
    "real_gtin13" TEXT NOT NULL,
    "mapped_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "mapped_by_user_id" INTEGER NOT NULL,
    "mapping_type" TEXT NOT NULL,

    CONSTRAINT "provisional_part_mapping_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_transition_log" (
    "id" SERIAL NOT NULL,
    "workflow_type" TEXT NOT NULL,
    "record_id" INTEGER NOT NULL,
    "from_status" TEXT NOT NULL,
    "to_status" TEXT NOT NULL,
    "transitioned_by_user_id" INTEGER,
    "transitioned_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "note" TEXT,

    CONSTRAINT "workflow_transition_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "org_events" (
    "id" SERIAL NOT NULL,
    "org_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "org_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "reference_conflicts_item_reference_id_receipt_id_line_item__key" ON "reference_conflicts"("item_reference_id", "receipt_id", "line_item_id");

-- CreateIndex
CREATE UNIQUE INDEX "provisional_items_provisional_gtin13_key" ON "provisional_items"("provisional_gtin13");

-- AddForeignKey
ALTER TABLE "subcategories" ADD CONSTRAINT "subcategories_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "categories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "items" ADD CONSTRAINT "items_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "items" ADD CONSTRAINT "items_subcategory_id_fkey" FOREIGN KEY ("subcategory_id") REFERENCES "subcategories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "item_references" ADD CONSTRAINT "item_references_gtin13_fkey" FOREIGN KEY ("gtin13") REFERENCES "items"("gtin13") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reference_conflicts" ADD CONSTRAINT "reference_conflicts_item_reference_id_fkey" FOREIGN KEY ("item_reference_id") REFERENCES "item_references"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "item_reference_proposals" ADD CONSTRAINT "item_reference_proposals_gtin13_fkey" FOREIGN KEY ("gtin13") REFERENCES "items"("gtin13") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversion_challenges" ADD CONSTRAINT "conversion_challenges_item_reference_id_fkey" FOREIGN KEY ("item_reference_id") REFERENCES "item_references"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provisional_items" ADD CONSTRAINT "provisional_items_proposed_category_id_fkey" FOREIGN KEY ("proposed_category_id") REFERENCES "categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provisional_items" ADD CONSTRAINT "provisional_items_proposed_subcategory_id_fkey" FOREIGN KEY ("proposed_subcategory_id") REFERENCES "subcategories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provisional_items" ADD CONSTRAINT "provisional_items_result_gtin13_fkey" FOREIGN KEY ("result_gtin13") REFERENCES "items"("gtin13") ON DELETE SET NULL ON UPDATE CASCADE;

