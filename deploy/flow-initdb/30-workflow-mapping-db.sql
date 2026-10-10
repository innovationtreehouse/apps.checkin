-- #1289: workflow mapping runs on its own dedicated database on the same
-- Postgres server (WORKFLOW_MAPPING_DATABASE_URL). Created here on first boot
-- of the flow-test Postgres.
CREATE DATABASE workflow_mapping OWNER prisma;
