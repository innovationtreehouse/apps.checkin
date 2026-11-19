-- The value finance sets on a receipt line priced at $0.
ALTER TABLE "in_kind_donation_lines" ADD COLUMN "finance_value_cents" INTEGER;
