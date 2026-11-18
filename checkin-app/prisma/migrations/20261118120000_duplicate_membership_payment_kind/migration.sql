-- Additive enum value: a paid membership order on an application whose year is
-- already settled. Raised for board review; no row changes.
--
-- ALTER TYPE ... ADD VALUE is safe on live data (no rewrite, no existing row
-- changes). The value is not used in this migration, so it may run inside a
-- transaction (Postgres 12+).
BEGIN;
ALTER TYPE "PaymentExceptionKind" ADD VALUE IF NOT EXISTS 'DUPLICATE_MEMBERSHIP_PAYMENT';
COMMIT;
