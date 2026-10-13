-- #1272: expense runs on its own dedicated database on the same Postgres server
-- (design §4, EXPENSE_DATABASE_URL). Created here on first init; the app container
-- then runs `prisma migrate deploy` + seed into it.
CREATE DATABASE expense OWNER prisma;
