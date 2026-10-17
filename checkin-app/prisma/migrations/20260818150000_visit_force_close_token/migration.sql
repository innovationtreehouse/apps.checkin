-- Expand-only: one nullable column. The previous release never names it in a
-- SELECT, so its reads are unaffected (rule 1). IF NOT EXISTS keeps the file
-- retry-safe if the deploy is re-run after a partial failure.
ALTER TABLE "Visit" ADD COLUMN IF NOT EXISTS "forceCloseToken" TEXT;
