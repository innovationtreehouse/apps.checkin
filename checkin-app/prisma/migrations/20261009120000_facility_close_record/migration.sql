BEGIN;

-- CreateEnum
CREATE TYPE "FacilityCloseVia" AS ENUM ('KIOSK', 'KIOSK_OFFLINE', 'WEB_CHECKOUT', 'WEB_DASHBOARD', 'WEB_CORRECTION', 'WEB_REMOVAL', 'NIGHTLY_SWEEP');

-- AlterTable
ALTER TABLE "Visit" ADD COLUMN     "facilityCloseId" INTEGER;

-- CreateTable
CREATE TABLE "FacilityClose" (
    "id" SERIAL NOT NULL,
    "closedAt" TIMESTAMP(3) NOT NULL,
    "closedById" INTEGER,
    "via" "FacilityCloseVia" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FacilityClose_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FacilityClose_closedById_idx" ON "FacilityClose"("closedById");

-- CreateIndex
CREATE INDEX "Visit_facilityCloseId_idx" ON "Visit"("facilityCloseId");

-- AddForeignKey
ALTER TABLE "Visit" ADD CONSTRAINT "Visit_facilityCloseId_fkey" FOREIGN KEY ("facilityCloseId") REFERENCES "FacilityClose"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FacilityClose" ADD CONSTRAINT "FacilityClose_closedById_fkey" FOREIGN KEY ("closedById") REFERENCES "Person"("id") ON DELETE SET NULL ON UPDATE CASCADE;


COMMIT;
