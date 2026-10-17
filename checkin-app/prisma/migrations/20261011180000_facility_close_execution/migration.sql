BEGIN;
ALTER TABLE "FacilityClose" ADD COLUMN "clientEventId" TEXT;
-- The default marks rows written by code that sweeps as it records (the
-- deploy drain's old tasks, the nightly cron) as already executed.
ALTER TABLE "FacilityClose" ADD COLUMN "executedAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP;
UPDATE "FacilityClose" SET "executedAt" = "createdAt";
CREATE UNIQUE INDEX "FacilityClose_clientEventId_key" ON "FacilityClose"("clientEventId");
CREATE INDEX "FacilityClose_executedAt_idx" ON "FacilityClose"("executedAt");
COMMIT;
