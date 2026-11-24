-- One Shopify reconcile pass at a time: the daily cron and the payments page's refresh share this lease.
BEGIN;

ALTER TABLE "BoardSettings" ADD COLUMN "shopifyReconcileLeaseUntil" TIMESTAMP(3);
ALTER TABLE "BoardSettings" ADD COLUMN "shopifyReconcileLeaseToken" TEXT;

COMMIT;
