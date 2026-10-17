-- The unsynced-scans queue predicate (reviewReason set, not yet reviewed) is
-- counted on every full-access /api/attendance poll for the door display's
-- need-review badge — once a minute, forever, on an append-only scan log with
-- no covering index. A partial index keeps that count O(queue size) instead of
-- a sequential scan of the whole table. Same shape as the one-open-visit
-- partial index; Prisma cannot express a partial WHERE, so it is hand-written.
--
-- CONCURRENTLY: RawBadgeLog is a live, high-traffic table — a plain index build
-- would hold a SHARE lock across every door scan INSERT for the whole build
-- (same rule as 20260818140000_raw_badge_log_client_event_id). A migration
-- containing CREATE INDEX CONCURRENTLY runs outside a transaction automatically.
-- IF NOT EXISTS makes it retry-safe: a CONCURRENTLY build killed mid-way leaves
-- an invalid index behind that a plain re-run would trip on.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "RawBadgeLog_review_queue" ON "RawBadgeLog"("id")
    WHERE ("reviewReason" IS NOT NULL AND "reviewedAt" IS NULL);
