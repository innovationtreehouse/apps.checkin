-- Additive enum values: what a household's denial leaves for the board to remove
-- by hand — program enrollments, program roles, and mailing lists.
--
-- ALTER TYPE ... ADD VALUE is safe on live data (no rewrite, no existing row
-- changes) and additive-only. No value is consumed in this migration, so all may
-- run in one transaction (Postgres 12+).
BEGIN;
ALTER TYPE "PaymentExceptionKind" ADD VALUE IF NOT EXISTS 'DENIED_HOUSEHOLD_ENROLLMENT';
ALTER TYPE "PaymentExceptionKind" ADD VALUE IF NOT EXISTS 'DENIED_HOUSEHOLD_PROGRAM_ROLE';
ALTER TYPE "PaymentExceptionKind" ADD VALUE IF NOT EXISTS 'DENIED_HOUSEHOLD_MAILING_LISTS';
COMMIT;
