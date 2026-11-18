-- Drops the duplicate columns nothing reads. A receipt whose flag was cleared through
-- duplicate_flag_cleared_at still holds duplicate_flagged_at, which would label a later
-- discard a duplicate, so the stamp is emptied first. A flag raised after that clear, or
-- still open, keeps its stamp.
BEGIN;

UPDATE "receipt_details" SET "duplicate_flagged_at" = NULL
WHERE "duplicate_flag_cleared_at" IS NOT NULL
  AND "duplicate_flagged_at" <= "duplicate_flag_cleared_at"
  AND "state" <> 'duplicate_flagged';

ALTER TABLE "receipt_details"
  DROP COLUMN "duplicate_flag_cleared_at",
  DROP COLUMN "duplicate_suspect_receipt_id",
  DROP COLUMN "duplicate_suspect_is_rejected";

COMMIT;
