-- Review stamp for parked kiosk scans (docs/designs/KIOSK_RESILIENCE.md §2 D7).
-- Expand-only: two nullable columns the previous release never names in a
-- SELECT, so its reads are unaffected (rule 1). Every existing parked row
-- keeps reviewedAt NULL, which is what puts it in the review queue — the
-- existing parked backlog shows up on first load, by design.
--
-- Both columns are one unit (a stamp with no actor is not a dismissal), so
-- BEGIN/COMMIT — prisma migrate deploy does not wrap a migration file in a
-- transaction (rule 5). IF NOT EXISTS keeps it retry-safe after a partial run.
--
-- No index: the queue is `reviewReason IS NOT NULL AND reviewedAt IS NULL` over
-- a table whose parked rows are a handful per outage, and the route takes 100
-- newest. Add a partial index if the parked population ever stops being small.
BEGIN;

ALTER TABLE "RawBadgeLog" ADD COLUMN IF NOT EXISTS "reviewedAt" TIMESTAMP(3);
ALTER TABLE "RawBadgeLog" ADD COLUMN IF NOT EXISTS "reviewedBy" INTEGER;

COMMIT;
