-- Per-adult background-check subjects (#1260).
--
-- Additive: `subjectPersonId` is nullable with no backfill, so old code (which
-- never writes it) keeps working through the rolling-deploy drain window and
-- its rows read as legacy — clearance stamps nobody for them.
--
-- HAND-WRITTEN, do not regenerate. The unique index carries `NULLS NOT
-- DISTINCT`, which Prisma cannot express: without it Postgres treats every
-- (process, reviewer, NULL) row as distinct and a PERSON_BG reviewer could
-- attest twice. `prisma migrate diff` does not see the attribute, so a
-- regenerated migration would silently drop it. If this migration is ever
-- coalesced, re-apply the attribute by hand and verify with
-- scripts/compare-schema-dumps.sh.
--
-- Prisma does not wrap migrations in a transaction (prisma/prisma#15295) and
-- these statements must succeed together.
BEGIN;

ALTER TABLE "BackgroundCheckAttestation" ADD COLUMN "subjectPersonId" INTEGER;

ALTER TABLE "BackgroundCheckAttestation"
    ADD CONSTRAINT "BackgroundCheckAttestation_subjectPersonId_fkey"
    FOREIGN KEY ("subjectPersonId") REFERENCES "Person"("id") ON DELETE SET NULL ON UPDATE CASCADE;

DROP INDEX "BackgroundCheckAttestation_processId_reviewerId_key";

CREATE UNIQUE INDEX "BgAttestation_processId_reviewerId_subjectPersonId_key"
    ON "BackgroundCheckAttestation" ("processId", "reviewerId", "subjectPersonId") NULLS NOT DISTINCT;

COMMIT;
