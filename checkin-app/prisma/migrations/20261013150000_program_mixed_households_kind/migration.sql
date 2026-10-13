-- Additive enum value: a paid program order naming children from more than one
-- household. Raised for board review; no row changes.
--
-- ALTER TYPE ... ADD VALUE is safe on live data (no rewrite, no existing row
-- changes) and additive-only. Not consumed in this migration.
ALTER TYPE "PaymentExceptionKind" ADD VALUE IF NOT EXISTS 'MIXED_HOUSEHOLDS';
