-- Store a blank Person.email as null, as every write path now does.
UPDATE "Person" SET email = NULL WHERE trim(email) = '';
