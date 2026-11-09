-- Drop Person.mergedIntoId: merges delete the merged-away row and archive it in
-- PersonMerge, so nothing reads or writes the column (#1456).
-- Fails closed if any row still points at a merge survivor.
BEGIN;

DO $$
DECLARE
    tombstones integer;
BEGIN
    SELECT count(*) INTO tombstones FROM "Person" WHERE "mergedIntoId" IS NOT NULL;

    IF tombstones > 0 THEN
        RAISE EXCEPTION 'Refusing to drop Person.mergedIntoId: % row(s) still set it', tombstones;
    END IF;
END $$;

-- DropForeignKey
ALTER TABLE "Person" DROP CONSTRAINT "Person_mergedIntoId_fkey";

-- AlterTable
ALTER TABLE "Person" DROP COLUMN "mergedIntoId";

COMMIT;
