-- Additive enum values: what a household's denial leaves for the board to remove
-- by hand — program enrollments and program roles.
--
-- ALTER TYPE ... ADD VALUE is safe on live data (no rewrite, no existing row
-- changes) and additive-only. Neither value is consumed in this migration, so both may
-- run in one transaction (Postgres 12+).
BEGIN;
ALTER TYPE "PaymentExceptionKind" ADD VALUE IF NOT EXISTS 'DENIED_HOUSEHOLD_ENROLLMENT';
ALTER TYPE "PaymentExceptionKind" ADD VALUE IF NOT EXISTS 'DENIED_HOUSEHOLD_PROGRAM_ROLE';
COMMIT;
