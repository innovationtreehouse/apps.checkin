-- A receive-queue cancel is a recorded state, and a stored resolution keeps the event's conversion factor.
ALTER TABLE "receive_queue" ADD COLUMN "cancelled_at" TIMESTAMP(3),
ADD COLUMN "cancelled_by" INTEGER,
ADD COLUMN "cancelled_by_username" TEXT;

ALTER TABLE "provisional_resolutions" ADD COLUMN "conversion_factor" INTEGER;
