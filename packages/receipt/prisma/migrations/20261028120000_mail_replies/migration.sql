-- One acknowledgement owed per mailed message: to its sender, and to the credited person when different.
BEGIN;

CREATE TABLE "receipt_mail_replies" (
    "id" SERIAL NOT NULL,
    "org_id" TEXT NOT NULL,
    "gmail_message_id" TEXT NOT NULL,
    "sender_address" TEXT NOT NULL,
    "received_at" TIMESTAMP(3) NOT NULL,
    "reply_to_sender" BOOLEAN NOT NULL,
    "claimed_at" TIMESTAMP(3),
    "sender_sent_at" TIMESTAMP(3),
    "credited_sent_at" TIMESTAMP(3),
    "done_at" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "receipt_mail_replies_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "receipt_mail_replies_gmail_message_id_key" ON "receipt_mail_replies"("gmail_message_id");

CREATE INDEX "receipt_mail_replies_org_id_done_at_idx" ON "receipt_mail_replies"("org_id", "done_at");

COMMIT;
