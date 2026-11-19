-- The value finance sets on a receipt line that comes to $0.
ALTER TABLE "in_kind_donation_lines" ADD COLUMN "finance_value_cents" INTEGER;
