-- One mail intake run at a time per org, and the last run's counts.
CREATE TABLE "receipt_mail_lease" (
    "org_id" TEXT NOT NULL,
    "until" TIMESTAMP(3) NOT NULL,
    "last_run_at" TIMESTAMP(3),
    "last_run" JSONB,

    CONSTRAINT "receipt_mail_lease_pkey" PRIMARY KEY ("org_id")
);
