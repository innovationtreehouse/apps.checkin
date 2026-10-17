-- Capture the conversion factor (inventory units per receipt-line unit) per
-- recognized/provisional line so it can be carried onto the S3 delta. Integer,
-- forward-only; existing rows default to 1 ("each").
ALTER TABLE "received_receipt_line_statuses" ADD COLUMN "conversion_factor" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "received_receipt_line_statuses" ADD COLUMN "conversion_version" INTEGER NOT NULL DEFAULT 1;
