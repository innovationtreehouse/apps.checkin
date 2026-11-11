-- The files refused from a mailed message, and when the sender was told.
BEGIN;

ALTER TABLE "receipt_mail_items" ADD COLUMN "refusal" JSONB;
ALTER TABLE "receipt_mail_replies" ADD COLUMN "refusals" JSONB NOT NULL DEFAULT '[]';
ALTER TABLE "receipt_mail_replies" ADD COLUMN "refusal_sent_at" TIMESTAMP(3);

COMMIT;
