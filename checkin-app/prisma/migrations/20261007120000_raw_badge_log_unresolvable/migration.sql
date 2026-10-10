-- A dead-lettered kiosk read that names no person still lands in the review
-- queue: personId becomes nullable and the raw value read is kept beside it.
-- The FK stays ON DELETE RESTRICT.
ALTER TABLE "RawBadgeLog" ALTER COLUMN "personId" DROP NOT NULL,
    ADD COLUMN "scannedValue" TEXT;
