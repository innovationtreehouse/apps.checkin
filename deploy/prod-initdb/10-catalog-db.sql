-- #1286 §4/§9: the global catalog runs on its own dedicated database on the same
-- Postgres server as checkin (CATALOG_DATABASE_URL). Postgres auto-creates only
-- POSTGRES_DB (checkmein), so create the catalog database here on first init.
-- Runs ONLY on a fresh data volume — an already-initialized server needs the
-- database created out of band (`CREATE DATABASE catalog OWNER prisma;`).
-- Migrations (`prisma migrate deploy`) run separately, not here.
CREATE DATABASE catalog OWNER prisma;
