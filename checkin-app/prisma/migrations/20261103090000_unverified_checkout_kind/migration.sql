-- Additive enum value: a paid program order without a valid checkout signature
-- from the named children's own household. Raised for board review; no row changes.
--
-- ALTER TYPE ... ADD VALUE is safe on live data (no rewrite, no existing row
-- changes), additive-only, and allowed inside a transaction on Postgres 12+.
-- Not consumed in this migration.
BEGIN;
ALTER TYPE "PaymentExceptionKind" ADD VALUE IF NOT EXISTS 'UNVERIFIED_CHECKOUT';
COMMIT;
