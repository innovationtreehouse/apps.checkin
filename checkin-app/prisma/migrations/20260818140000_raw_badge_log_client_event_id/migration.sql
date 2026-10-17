-- Additive, nullable: legacy/web writers keep writing NULL clientEventId
-- (Postgres NULLs don't collide on a unique index), so nothing else changes.
-- clientEventId is the kiosk replay idempotency key; reviewReason marks a
-- replay parked instead of toggled (docs/designs/KIOSK_RESILIENCE.md §2).
-- IF NOT EXISTS / IF EXISTS make this retry-safe: CONCURRENTLY can't run in a
-- transaction, so a prior attempt killed mid-way can leave columns applied
-- and/or an invalid index behind for a retry to step on.
ALTER TABLE "RawBadgeLog" ADD COLUMN IF NOT EXISTS "clientEventId" TEXT;
ALTER TABLE "RawBadgeLog" ADD COLUMN IF NOT EXISTS "reviewReason" TEXT;

-- CONCURRENTLY: RawBadgeLog is a live, high-traffic table — a plain unique
-- index build would hold a lock across it. A migration containing
-- CREATE INDEX CONCURRENTLY runs outside a transaction automatically.
DROP INDEX IF EXISTS "RawBadgeLog_clientEventId_key";
CREATE UNIQUE INDEX CONCURRENTLY "RawBadgeLog_clientEventId_key" ON "RawBadgeLog"("clientEventId");
