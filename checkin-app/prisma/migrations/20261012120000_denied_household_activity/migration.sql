-- Additive enum value: activity that reaches a DENIED household (payment, approval,
-- application start) is raised to the board's payment-exceptions queue. No drop,
-- no rename, no backfill; the value is not used by this migration.
ALTER TYPE "PaymentExceptionKind" ADD VALUE IF NOT EXISTS 'DENIED_HOUSEHOLD_ACTIVITY';
