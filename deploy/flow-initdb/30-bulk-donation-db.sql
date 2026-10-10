-- #1280: bulk donation runs on its own dedicated database on the same Postgres
-- server (BULK_DONATION_DATABASE_URL). Created here on first init; the app
-- container then runs `prisma migrate deploy` + seed into it.
CREATE DATABASE bulk_donation OWNER prisma;
