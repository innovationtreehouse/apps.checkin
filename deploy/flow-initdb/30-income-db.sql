-- #1283: income runs on its own dedicated database on the same Postgres server
-- (INCOME_DATABASE_URL). Created here on first init; the app container then runs
-- `prisma migrate deploy` + seed into it.
CREATE DATABASE income OWNER prisma;
