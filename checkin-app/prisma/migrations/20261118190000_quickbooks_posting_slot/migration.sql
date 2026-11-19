-- One QuickBooks posting run at a time per org, and the lanes waiting their turn.
BEGIN;

CREATE TABLE "quickbooks_posting_slot" (
    "org_id" TEXT NOT NULL,
    "holder" TEXT,
    "run_id" TEXT,
    "until" TIMESTAMP(3) NOT NULL,
    "last_runs" JSONB,

    CONSTRAINT "quickbooks_posting_slot_pkey" PRIMARY KEY ("org_id")
);

CREATE TABLE "quickbooks_posting_queue" (
    "id" SERIAL NOT NULL,
    "org_id" TEXT NOT NULL,
    "lane" TEXT NOT NULL,
    "requested_by_id" INTEGER,
    "requested_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "quickbooks_posting_queue_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "quickbooks_posting_queue_org_id_lane_key" ON "quickbooks_posting_queue"("org_id", "lane");

COMMIT;
