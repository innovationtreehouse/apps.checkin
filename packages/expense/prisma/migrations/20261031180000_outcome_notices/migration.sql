-- One email owed per expense outcome: to the receipt's uploader, and to the person reimbursed when different.
BEGIN;

CREATE TABLE "expense_outcome_notices" (
    "id" SERIAL NOT NULL,
    "org_id" TEXT NOT NULL,
    "expense_id" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "claimed_at" TIMESTAMP(3),
    "uploader_sent_at" TIMESTAMP(3),
    "reimbursee_sent_at" TIMESTAMP(3),
    "done_at" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "expense_outcome_notices_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "expense_outcome_notices_expense_id_event_key" ON "expense_outcome_notices"("expense_id", "event");

CREATE INDEX "expense_outcome_notices_org_id_done_at_idx" ON "expense_outcome_notices"("org_id", "done_at");

COMMIT;
