-- Record how each visit started, so the close sweep and the scan route stop
-- inferring a live arrival from a RawBadgeLog row just before arrivedAt.
-- Expand-only: a new enum and a nullable column (metadata-only, no rewrite,
-- no backfill). Old rows stay null and keep the heuristic; old code ignores it.
CREATE TYPE "VisitArrivalSource" AS ENUM ('LIVE_SCAN', 'REPLAYED_SCAN', 'WEB_CHECKIN', 'WEB_MANUAL', 'STAFF_INSERT', 'EVENT_MARK', 'REVIEW_PANEL', 'SEED');

ALTER TABLE "Visit" ADD COLUMN "arrivalSource" "VisitArrivalSource";
