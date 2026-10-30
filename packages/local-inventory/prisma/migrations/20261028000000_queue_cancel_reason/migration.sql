BEGIN;
-- A receive-queue cancel records the reason given for it.
ALTER TABLE "receive_queue" ADD COLUMN "cancel_reason" TEXT;
COMMIT;
