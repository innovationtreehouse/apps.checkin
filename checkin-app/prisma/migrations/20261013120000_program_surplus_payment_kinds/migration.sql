-- Additive enum values: a paid program order with seats no pending enrollment
-- consumes — a person already enrolled (DUPLICATE_PAYMENT) or nobody awaiting
-- (UNCLAIMED_SEATS). Raised for board review; no row changes.
--
-- ALTER TYPE ... ADD VALUE is safe on live data (no rewrite, no existing row
-- changes) and additive-only. Neither value is consumed in this migration, so both may run in one
-- transaction (Postgres 12+).
BEGIN;
ALTER TYPE "PaymentExceptionKind" ADD VALUE IF NOT EXISTS 'DUPLICATE_PAYMENT';
ALTER TYPE "PaymentExceptionKind" ADD VALUE IF NOT EXISTS 'UNCLAIMED_SEATS';
COMMIT;
