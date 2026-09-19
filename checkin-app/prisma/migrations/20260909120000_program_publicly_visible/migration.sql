-- Additive, NOT NULL with a default: the default backfills every existing row
-- atomically, and old code that neither selects nor writes this column keeps
-- serving unchanged for the whole drain window.
ALTER TABLE "Program" ADD COLUMN "publiclyVisible" BOOLEAN NOT NULL DEFAULT false;
