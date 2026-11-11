-- Deletes each merged-away Person row ("tombstone") that the merge archive
-- already records and that nothing references any more (#1456 2b-3). Data only.
--
-- Fail-closed: a tombstone with no PersonMerge row, or with any row in any table
-- holding a foreign key to Person (read from pg_constraint, so CASCADE and
-- SET NULL references block it as RESTRICT ones do), is kept, as is one whose
-- DELETE fails. An unexpected error rolls the block back and keeps every row.
-- The block never raises: a failed migration blocks every later deploy (P3009).
-- Passes repeat until one deletes nothing, so a chain of tombstones pointing at
-- each other clears whatever order the rows come in.
BEGIN;

-- tombstoneDelete.integration.test.ts runs everything between these markers.
-- >>> DELETE START
DO $$
DECLARE
  tombstone_id INT;
  fk RECORD;
  referenced BOOLEAN;
  deleted_this_pass INT;
  deleted_total INT := 0;
BEGIN
  LOOP
    deleted_this_pass := 0;
    FOR tombstone_id IN
      SELECT p.id FROM "Person" p
      WHERE p."mergedIntoId" IS NOT NULL
        AND EXISTS (SELECT 1 FROM "PersonMerge" m WHERE m."fromId" = p.id)
      ORDER BY p.id
    LOOP
      referenced := FALSE;
      FOR fk IN
        SELECT c.conrelid::regclass AS tbl, a.attname AS col
        FROM pg_constraint c
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
        WHERE c.contype = 'f' AND c.confrelid = '"Person"'::regclass
      LOOP
        EXECUTE format('SELECT EXISTS (SELECT 1 FROM %s WHERE %I = $1)', fk.tbl, fk.col)
          INTO referenced USING tombstone_id;
        EXIT WHEN referenced;
      END LOOP;
      CONTINUE WHEN referenced;

      BEGIN
        DELETE FROM "Person" WHERE id = tombstone_id;
        deleted_this_pass := deleted_this_pass + 1;
      EXCEPTION WHEN OTHERS THEN
        RAISE NOTICE 'tombstone % kept: %', tombstone_id, SQLERRM;
      END;
    END LOOP;
    deleted_total := deleted_total + deleted_this_pass;
    EXIT WHEN deleted_this_pass = 0;
  END LOOP;
  RAISE NOTICE 'merged tombstones deleted: %, kept: %', deleted_total,
    (SELECT count(*) FROM "Person" WHERE "mergedIntoId" IS NOT NULL);
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'tombstone delete skipped, no rows deleted: %', SQLERRM;
END $$;
-- >>> DELETE END

COMMIT;
