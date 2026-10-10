-- #1265: receipt runs on its own dedicated database on the same Postgres server
-- (RECEIPT_DATABASE_URL). Created here on first init; the app container then runs
-- `prisma migrate deploy` into it.
CREATE DATABASE receipt OWNER prisma;
