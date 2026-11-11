-- The switch that stops automatic receipt reading; on unless finance turns it off.
BEGIN;

ALTER TABLE "org_settings" ADD COLUMN "ocr_enabled" BOOLEAN NOT NULL DEFAULT true;

COMMIT;
