-- The reconcile cursor pairs a mirror sync stamp with an order GID, so orders sharing a stamp are never skipped.
BEGIN;

ALTER TABLE "BoardSettings" ADD COLUMN "shopifyReconcileCursorGid" TEXT;

COMMIT;
