-- PersonMerge: the permanent record of a participant merge (#1456 phase 2b).
--
-- Purely additive — a new table nothing reads yet — so it is safe for the old
-- task serving traffic during the deploy drain window, and rule 1 permits it to
-- ship in the same release as the code that starts writing it.
--
-- This release only ARCHIVES. The tombstone Person row is still written and
-- still kept (mergedIntoId, the CAS, the whole live-person filter); the delete
-- is 2b-3, after the 2a census. So the table backfills forward from now and the
-- two records agree until then.
--
-- "fromId" carries no foreign key ON PURPOSE. Every other Person reference in
-- this schema is an FK; this one cannot be, because the row exists precisely to
-- outlive the Person it names. UNIQUE instead: the merge CAS already lets a
-- person be merged away exactly once, and the constraint is what makes the
-- kiosk scan path's lookup a findUnique and a double-archive impossible.
--
-- No backfill for existing tombstones — that is the 2a residue task, run against
-- prod with the census, not a migration (a migration cannot make the human calls
-- 2a needs, and this table's readers tolerate its absence: both fall back to the
-- tombstone row while it still exists).
--
-- Four statements that must land together — BEGIN/COMMIT, since prisma migrate
-- deploy does not wrap a migration file in a transaction (rule 5).
BEGIN;

CREATE TABLE "PersonMerge" (
    "id"       SERIAL       NOT NULL,
    "fromId"   INTEGER      NOT NULL,
    "toId"     INTEGER      NOT NULL,
    "mergedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "snapshot" JSONB        NOT NULL,

    CONSTRAINT "PersonMerge_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PersonMerge_fromId_key" ON "PersonMerge"("fromId");

CREATE INDEX "PersonMerge_toId_idx" ON "PersonMerge"("toId");

-- RESTRICT, matching the Person FKs that carry an audit fact: the survivor of a
-- merge must not be deletable out from under the record of it. (Nothing deletes
-- a Person today; auth-options' deleteUser is the one path, and a survivor
-- reachable from here should refuse rather than orphan the archive.)
ALTER TABLE "PersonMerge" ADD CONSTRAINT "PersonMerge_toId_fkey"
    FOREIGN KEY ("toId") REFERENCES "Person"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

COMMIT;
