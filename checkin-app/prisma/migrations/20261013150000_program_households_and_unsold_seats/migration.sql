-- Additive enum value: a paid program order naming children from more than one
-- household. Raised for board review; no row changes.
--
-- ALTER TYPE ... ADD VALUE is safe on live data (no rewrite, no existing row
-- changes) and additive-only. Not consumed in this migration.
ALTER TYPE "PaymentExceptionKind" ADD VALUE IF NOT EXISTS 'MIXED_HOUSEHOLDS';

-- Additive nullable column: when an enrollment took its seat out of Shopify
-- without a sale (admin comp, approved scholarship). Withdrawal returns the seat
-- only when it is set. No backfill: existing comps and approvals carry no record
-- of a -1 and keep their old behavior (no automatic return). Nullable ADD COLUMN
-- without a default is metadata-only on Postgres 11+, and old code ignores it.
ALTER TABLE "ProgramParticipant" ADD COLUMN "seatTakenWithoutSaleAt" TIMESTAMP(3);
