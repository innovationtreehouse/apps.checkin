-- Visit tombstone (AT5, design doc 1256_ATTENDANCE_CORRECTION_SURFACE.md §3):
-- a deleted visit keeps its row — reviewable and reversible. Additive columns,
-- both nullable; no backfill needed (every existing row is live).
--
-- The one-open-visit partial unique index must not count a tombstoned row as
-- "open", or a soft-deleted open visit would block that person's next check-in
-- forever. Recreate it with deletedAt in the predicate. Wrapped in a
-- transaction: prisma migrate deploy does not add one, and the index swap must
-- not commit without the columns (or vice versa).
BEGIN;

ALTER TABLE "Visit" ADD COLUMN "deletedAt" TIMESTAMP(3);
ALTER TABLE "Visit" ADD COLUMN "deletedById" INTEGER;

DROP INDEX "Visit_one_open_per_participant";
CREATE UNIQUE INDEX "Visit_one_open_per_participant" ON "Visit"("personId")
    WHERE ("departedAt" IS NULL AND "deletedAt" IS NULL);

COMMIT;
