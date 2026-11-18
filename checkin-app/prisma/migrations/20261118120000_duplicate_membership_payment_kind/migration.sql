-- Additive enum value: a paid membership order on an application whose year is
-- already settled. Raised for board review; no row changes.
--
-- ALTER TYPE ... ADD VALUE is safe on live data (no rewrite, no existing row
-- changes). Old code never writes or reads the value by name, so it is safe
-- through the drain window. Not consumed in this migration.
ALTER TYPE "PaymentExceptionKind" ADD VALUE IF NOT EXISTS 'DUPLICATE_MEMBERSHIP_PAYMENT';
