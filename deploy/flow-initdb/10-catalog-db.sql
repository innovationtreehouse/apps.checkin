-- #1286: the global catalog runs on its own dedicated database on the same
-- Postgres server (design §4, CATALOG_DATABASE_URL). This flow harness DB only
-- auto-creates POSTGRES_DB (checkmein), so create the catalog database here on
-- first init; the app container then runs `prisma migrate deploy` + seed into it.
CREATE DATABASE catalog OWNER prisma;
