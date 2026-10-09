-- AlterTable
ALTER TABLE "expense_line_items" ADD COLUMN     "qb_match_state" TEXT NOT NULL DEFAULT 'UNMATCHED',
ADD COLUMN     "qb_txn_id" TEXT;

-- AlterTable
ALTER TABLE "expenses" ADD COLUMN     "note_in_lieu_of_receipt" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "org_settings" ADD COLUMN     "board_review_total_cents" INTEGER NOT NULL DEFAULT 200000,
ADD COLUMN     "capital_equipment_unit_cents" INTEGER NOT NULL DEFAULT 50000,
ADD COLUMN     "note_in_lieu_limit_cents" INTEGER NOT NULL DEFAULT 5000;

-- CreateTable
CREATE TABLE "org_settings_changes" (
    "id" SERIAL NOT NULL,
    "org_id" TEXT NOT NULL,
    "actor_user_id" INTEGER NOT NULL,
    "actor_username" TEXT,
    "before" TEXT,
    "after" TEXT NOT NULL,
    "changed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "org_settings_changes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "org_settings_changes_org_id_idx" ON "org_settings_changes"("org_id");

-- AlterTable
ALTER TABLE "line_item_owner_approvals" DROP COLUMN "budget_owner_user_id";

-- DropTable
DROP TABLE "settingsData";

-- CreateTable
CREATE TABLE "qb_match_exclusion" (
    "id" SERIAL NOT NULL,
    "org_id" TEXT NOT NULL,
    "qb_txn_id" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "excluded_by_user_id" INTEGER NOT NULL,
    "excluded_by_username" TEXT,
    "excluded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "qb_match_exclusion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "expense_line_signoffs" (
    "id" SERIAL NOT NULL,
    "expense_id" TEXT NOT NULL,
    "line_item_id" INTEGER NOT NULL,
    "seat" TEXT NOT NULL,
    "signer_user_id" INTEGER NOT NULL,
    "signer_username" TEXT,
    "signed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "expense_line_signoffs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "expense_flags" (
    "id" SERIAL NOT NULL,
    "org_id" TEXT NOT NULL,
    "expense_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "audience" TEXT NOT NULL,
    "detail" TEXT,
    "raised_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "checked_off_at" TIMESTAMP(3),
    "checked_off_by_user_id" INTEGER,
    "checked_off_by_username" TEXT,
    "notes" TEXT,

    CONSTRAINT "expense_flags_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "qb_match_exclusion_org_id_qb_txn_id_key" ON "qb_match_exclusion"("org_id", "qb_txn_id");

-- CreateIndex
CREATE UNIQUE INDEX "expense_line_signoffs_line_item_id_seat_key" ON "expense_line_signoffs"("line_item_id", "seat");

-- CreateIndex
CREATE UNIQUE INDEX "expense_line_signoffs_line_item_id_signer_user_id_key" ON "expense_line_signoffs"("line_item_id", "signer_user_id");

-- CreateIndex
CREATE INDEX "expense_flags_org_id_checked_off_at_idx" ON "expense_flags"("org_id", "checked_off_at");

-- CreateIndex
CREATE UNIQUE INDEX "expense_flags_expense_id_kind_key" ON "expense_flags"("expense_id", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "expense_line_items_qb_txn_id_key" ON "expense_line_items"("qb_txn_id");

-- AddForeignKey
ALTER TABLE "expense_line_signoffs" ADD CONSTRAINT "expense_line_signoffs_line_item_id_fkey" FOREIGN KEY ("line_item_id") REFERENCES "expense_line_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expense_flags" ADD CONSTRAINT "expense_flags_expense_id_fkey" FOREIGN KEY ("expense_id") REFERENCES "expenses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

