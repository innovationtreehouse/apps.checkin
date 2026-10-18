-- The mailbox ignore list: one row per file the organization says is never a receipt.
BEGIN;

CREATE TABLE "receipt_ignored_files" (
    "id" SERIAL NOT NULL,
    "org_id" TEXT NOT NULL,
    "file_hash" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "added_by_user_id" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "receipt_ignored_files_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "receipt_ignored_files_org_id_file_hash_key" ON "receipt_ignored_files"("org_id", "file_hash");

COMMIT;
