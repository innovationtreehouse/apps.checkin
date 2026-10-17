-- VisitSource split, stage 2 of 2: map the legacy `SYSTEM` rows onto the three
-- values added by the previous migration.
--
-- Today's SYSTEM departures are FUSED history — the discriminator between "the
-- building closed under you" and "the cron swept you at midnight" was never
-- stored, so it cannot be recovered after the fact. One case IS recoverable:
-- the roster mark is the only writer that puts SYSTEM on *arrivedVia*, and it
-- writes both fields together, so a SYSTEM/SYSTEM pair is unambiguously a lead
-- mark. Everything else falls back to AUTO_CLOSE — the conservative reading
-- ("do not trust this departure time"), which also makes those rows
-- source-suppressed in the correction-significance rule rather than flagging
-- their corrections to the board.
--
-- Order matters: departedVia is mapped FIRST, while arrivedVia still carries
-- the SYSTEM marker it keys on. Wrapped, because the two updates must land
-- together — prisma migrate deploy does not add a transaction of its own.

BEGIN;

UPDATE "Visit"
SET "departedVia" = CASE WHEN "arrivedVia" = 'SYSTEM' THEN 'LEAD_MARKED' ELSE 'AUTO_CLOSE' END::"VisitSource"
WHERE "departedVia" = 'SYSTEM';

UPDATE "Visit"
SET "arrivedVia" = 'LEAD_MARKED'
WHERE "arrivedVia" = 'SYSTEM';

COMMIT;
