-- mintPersonId() calls setval() on Person_id_seq so a later sequence-minted
-- insert cannot collide with a counter-issued id. Postgres requires UPDATE
-- on the sequence for setval; bootstrap only granted USAGE, SELECT, so the
-- app DML role 42501s on every first Google sign-in (the only login that
-- mints a Person). Returning logins never mint, which is why they still work.
--
-- Additive privilege, not a schema change — safe for old code during the
-- drain window (rule 1). Wrapped in BEGIN/COMMIT (rule 5). No-ops on a
-- database that has no DML role of these names (local/CI owner already
-- can setval).
BEGIN;

DO $$
DECLARE
  seq text;
  r text;
BEGIN
  seq := pg_get_serial_sequence('"Person"', 'id');
  IF seq IS NULL THEN
    RAISE EXCEPTION 'Person.id has no serial sequence';
  END IF;

  FOREACH r IN ARRAY ARRAY['checkin_prod_dml', 'checkin_dev_dml', 'checkin_stg_dml']
  LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('GRANT UPDATE ON SEQUENCE %s TO %I', seq, r);
    END IF;
  END LOOP;
END $$;

COMMIT;
