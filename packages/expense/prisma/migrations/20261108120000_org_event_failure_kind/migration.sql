BEGIN;

-- A failed catalog event's kind, and the tries a bug has used.
ALTER TABLE "received_org_events" ADD COLUMN "failure_kind" TEXT;
ALTER TABLE "received_org_events" ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 0;

COMMIT;
