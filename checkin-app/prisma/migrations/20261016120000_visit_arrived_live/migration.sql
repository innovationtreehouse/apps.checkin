-- Record whether a SCANNER visit began with a live badge, so the close sweep
-- and the scan route stop inferring it from a RawBadgeLog row just before
-- arrivedAt. Expand-only: one nullable column (metadata-only, no rewrite,
-- no backfill). Old rows stay null and keep the heuristic; old code ignores it.
ALTER TABLE "Visit" ADD COLUMN "arrivedLive" BOOLEAN;
