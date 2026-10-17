-- #1432 Step 1: backfill every null/blank Person.name (owner ruling, Decisions
-- 1-3). Tombstones first so the mangled sentinel email never wins; local-part
-- next (the string these rows already display as, so the cutover is
-- invisible); Member #<id> only for a row with neither name nor email. Runs
-- over ALL rows (no LIVE_PERSON filter) — the eventual NOT NULL applies to
-- every row in the table. Idempotent: re-running matches nothing the first
-- pass already fixed.
BEGIN;
UPDATE "Person"
SET "name" = CASE
    WHEN "mergedIntoId" IS NOT NULL THEN 'Merged person #' || "id"
    WHEN NULLIF(split_part(COALESCE("email", ''), '@', 1), '') IS NOT NULL
        THEN split_part("email", '@', 1)
    ELSE 'Member #' || "id"
END
WHERE "name" IS NULL OR btrim("name") = '';
COMMIT;
