-- The value finance sets on a receipt line that comes to $0.
BEGIN;

ALTER TABLE "in_kind_donation_lines" ADD COLUMN "finance_value_cents" INTEGER;

COMMIT;
