BEGIN;

-- Capital review is an explicit setting, on by default. Existing rows keep their thresholds; a new
-- row's thresholds start unset rather than at $0.
ALTER TABLE "org_settings" ADD COLUMN "capital_review_enabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "org_settings" ALTER COLUMN "capital_total_threshold_cents" DROP NOT NULL;
ALTER TABLE "org_settings" ALTER COLUMN "capital_total_threshold_cents" DROP DEFAULT;
ALTER TABLE "org_settings" ALTER COLUMN "capital_line_item_threshold_cents" DROP NOT NULL;
ALTER TABLE "org_settings" ALTER COLUMN "capital_line_item_threshold_cents" DROP DEFAULT;

COMMIT;
