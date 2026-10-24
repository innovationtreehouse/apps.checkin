-- Binds a web close-choice token to the person who was shown the choice.
-- Expand-only: one nullable column, no default, no backfill. Old code serving
-- during the drain window neither writes nor reads it.
ALTER TABLE "Visit" ADD COLUMN "forceCloseActorId" INTEGER;
