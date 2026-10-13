-- Per-program off-sale date plus the sale sweep's two once-only markers.
-- Expand-only: nullable columns. Old code serving during the drain window
-- neither reads nor writes them; a program it creates gets a null offSaleAt,
-- which the app reads as the start date.
BEGIN;
ALTER TABLE "Program" ADD COLUMN "offSaleAt" DATE;
ALTER TABLE "Program" ADD COLUMN "saleEndedAt" TIMESTAMP(3);
ALTER TABLE "Program" ADD COLUMN "unpaidClaimsNotifiedAt" TIMESTAMP(3);
UPDATE "Program" SET "offSaleAt" = "startAt";
COMMIT;
