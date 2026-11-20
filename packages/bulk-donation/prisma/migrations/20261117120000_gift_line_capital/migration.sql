-- A gift's capital decision lives on its own lines; the gift records whether it needed review.
BEGIN;

ALTER TABLE "in_kind_donations" ADD COLUMN "capital_review_needed" BOOLEAN;
ALTER TABLE "manual_in_kind_donations" ADD COLUMN "capital_review_needed" BOOLEAN;

ALTER TABLE "in_kind_donation_lines" ADD COLUMN "is_capital" BOOLEAN,
ADD COLUMN "depreciation_years" INTEGER,
ADD COLUMN "capital_bucket_id" INTEGER,
ADD COLUMN "capital_decided_by_user_id" INTEGER,
ADD COLUMN "capital_decided_at" TIMESTAMP(3),
ADD COLUMN "registered_at" TIMESTAMP(3);

ALTER TABLE "manual_in_kind_donation_lines" ADD COLUMN "is_capital" BOOLEAN,
ADD COLUMN "depreciation_years" INTEGER,
ADD COLUMN "capital_bucket_id" INTEGER,
ADD COLUMN "capital_decided_by_user_id" INTEGER,
ADD COLUMN "capital_decided_at" TIMESTAMP(3),
ADD COLUMN "registered_at" TIMESTAMP(3);

COMMIT;
