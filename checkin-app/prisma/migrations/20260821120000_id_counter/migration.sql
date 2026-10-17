-- Monotonic ID source for Person. Purely additive: a new table plus its seed
-- row, nothing reads it until the code shipping alongside lands, so it is safe
-- for old code serving traffic during the deploy drain window (rule 1).
--
-- The seed clears the SEQUENCE, not just MAX(id): old code still mints from
-- Person_id_seq during the drain, so counter-issued IDs must start above
-- anything the sequence can hand out. Margin 64 = two Aurora prefetch batches.
--
-- Person.id and the @default(autoincrement()) are deliberately untouched —
-- dropping the default while old code runs would 500 every old create (rule 3).
--
-- Two statements that must land together (the table is useless without its
-- seed row) — BEGIN/COMMIT, since prisma migrate deploy does not wrap a
-- migration file in a transaction (rule 5).
BEGIN;

CREATE TABLE "IdCounter" (
    "name" TEXT NOT NULL,
    "value" INTEGER NOT NULL,

    CONSTRAINT "IdCounter_pkey" PRIMARY KEY ("name")
);

INSERT INTO "IdCounter" ("name", "value")
SELECT 'person', GREATEST(
    COALESCE((SELECT MAX("id") FROM "Person"), 0),
    COALESCE(pg_sequence_last_value(pg_get_serial_sequence('"Person"', 'id')::regclass), 0)
) + 64
ON CONFLICT ("name") DO NOTHING;

COMMIT;
