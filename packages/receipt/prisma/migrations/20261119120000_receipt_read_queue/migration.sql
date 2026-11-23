-- A receipt waiting to be read (ocr_queued) is dated by ocr_queued_at; captured mail gets one row per message.
BEGIN;
-- AlterTable
ALTER TABLE "receipt_details" ADD COLUMN     "ocr_queued_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "receipt_mail_message" (
    "id" SERIAL NOT NULL,
    "org_id" TEXT NOT NULL,
    "gmail_message_id" TEXT NOT NULL,
    "received_at" TIMESTAMP(3) NOT NULL,
    "captured_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "raw_key" TEXT NOT NULL,
    "raw_sha256" TEXT NOT NULL,
    "raw_size" INTEGER NOT NULL,
    "processed_at" TIMESTAMP(3),
    "process_error" TEXT,

    CONSTRAINT "receipt_mail_message_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "receipt_mail_message_org_id_gmail_message_id_key" ON "receipt_mail_message"("org_id", "gmail_message_id");


COMMIT;
