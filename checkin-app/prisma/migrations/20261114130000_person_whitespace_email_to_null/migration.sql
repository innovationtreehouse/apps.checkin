-- Store an all-whitespace Person.email (spaces, tabs, CR, LF) as null, as every write path does.
BEGIN;

UPDATE "Person" SET email = NULL WHERE email ~ '^\s*$';

COMMIT;
