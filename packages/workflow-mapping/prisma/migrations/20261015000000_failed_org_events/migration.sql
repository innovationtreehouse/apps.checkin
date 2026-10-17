-- Catalog events whose reaction failed, retried by id on catch-up.
CREATE TABLE "failed_org_events" (
    "id" INTEGER NOT NULL,
    "org_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "failure_reason" TEXT NOT NULL,
    "failed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "failed_org_events_pkey" PRIMARY KEY ("id")
);
