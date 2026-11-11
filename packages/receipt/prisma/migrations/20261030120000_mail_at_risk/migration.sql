-- Messages a mail run could not finish, kept until read clean or alerted and gone from the listing.
BEGIN;

CREATE TABLE "receipt_mail_at_risk" (
    "id" SERIAL NOT NULL,
    "org_id" TEXT NOT NULL,
    "gmail_message_id" TEXT NOT NULL,
    "received_at" TIMESTAMP(3),
    "alerted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "receipt_mail_at_risk_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "receipt_mail_at_risk_gmail_message_id_key" ON "receipt_mail_at_risk"("gmail_message_id");

CREATE INDEX "receipt_mail_at_risk_org_id_alerted_at_idx" ON "receipt_mail_at_risk"("org_id", "alerted_at");

COMMIT;
