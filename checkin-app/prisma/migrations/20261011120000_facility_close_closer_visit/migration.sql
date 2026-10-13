BEGIN;

-- AlterTable
ALTER TABLE "FacilityClose" ADD COLUMN     "closerVisitId" INTEGER;

-- CreateIndex
CREATE INDEX "FacilityClose_closerVisitId_idx" ON "FacilityClose"("closerVisitId");

COMMIT;
