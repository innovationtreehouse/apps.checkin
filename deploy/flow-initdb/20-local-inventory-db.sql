-- #1287: local inventory runs on its own dedicated database on the same
-- Postgres server (design §4, LOCAL_INVENTORY_DATABASE_URL). Created here on
-- first init; the app container then runs `prisma migrate deploy` + seed into it.
CREATE DATABASE local_inventory OWNER prisma;
