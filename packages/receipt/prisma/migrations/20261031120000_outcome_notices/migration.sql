-- One email owed per receipt outcome: to its uploader, and to the person reimbursed when different.
BEGIN;

CREATE TABLE "receipt_outcome_notices" (
    "id" SERIAL NOT NULL,
    "org_id" TEXT NOT NULL,
    "receipt_id" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "claimed_at" TIMESTAMP(3),
    "uploader_sent_at" TIMESTAMP(3),
    "reimbursee_sent_at" TIMESTAMP(3),
    "done_at" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "receipt_outcome_notices_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "receipt_outcome_notices_receipt_id_event_key" ON "receipt_outcome_notices"("receipt_id", "event");

CREATE INDEX "receipt_outcome_notices_org_id_done_at_idx" ON "receipt_outcome_notices"("org_id", "done_at");

COMMIT;
